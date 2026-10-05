import { migrate, reduce } from './engine';
import { createSeedState } from './seed';
import type { ChainState, Op, OpResult } from './types';

/** 可注入的键值存储，浏览器里是 localStorage，测试里是内存实现 */
export interface KVStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class MemoryKV implements KVStore {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

export interface StoreKeys {
  state: string;
  checkpoint: string;
  outbox: string;
}

export const DEFAULT_KEYS: StoreKeys = {
  state: 'type-pairer:chain:state',
  checkpoint: 'type-pairer:chain:checkpoint',
  outbox: 'type-pairer:chain:outbox',
};

export interface RecoverReport {
  source: 'state' | 'checkpoint' | 'seed';
  replayed: number;
  skipped: number;
  notes: string[];
}

/**
 * 发布链存储：
 * - 写入顺序为 outbox → 主状态 → 检查点，检查点只在主状态写完整后更新；
 * - 任何一步失败都保留 outbox，下次恢复时从最后一个完整检查点重放；
 * - 重放依靠 reduce 的 opId 幂等，不会重复生成发布/导出记录。
 */
export class ChainStore {
  private state: ChainState;
  private outbox: Op[] = [];
  private listeners = new Set<() => void>();
  /** 上次持久化是否失败（等待从检查点恢复） */
  degraded = false;
  lastReport: RecoverReport | null = null;

  constructor(
    private kv: KVStore,
    private keys: StoreKeys = DEFAULT_KEYS,
    legacyRaw?: unknown,
  ) {
    const { state, report } = this.recoverInternal(legacyRaw);
    this.state = state;
    this.lastReport = report;
    this.persist();
  }

  getState(): ChainState {
    return this.state;
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  private emit(): void {
    this.listeners.forEach(fn => fn());
  }

  dispatch(op: Op): OpResult {
    const result = reduce(this.state, op);
    if (!result.error && result.state !== this.state) {
      this.state = result.state;
      this.outbox = [...this.outbox, op];
      this.persist();
    }
    this.emit();
    return result;
  }

  /** 从存储重新恢复：主状态损坏时回退检查点，然后重放 outbox */
  recover(): RecoverReport {
    const { state, report } = this.recoverInternal();
    this.state = state;
    this.lastReport = report;
    this.persist();
    this.emit();
    return report;
  }

  private recoverInternal(legacyRaw?: unknown): { state: ChainState; report: RecoverReport } {
    let raw: unknown = null;
    let source: RecoverReport['source'] = 'seed';

    const rawState = this.kv.getItem(this.keys.state);
    if (rawState) {
      try {
        raw = JSON.parse(rawState);
        source = 'state';
      } catch {
        raw = null; // 主状态损坏，回退检查点
      }
    }
    if (raw === null) {
      const rawCheckpoint = this.kv.getItem(this.keys.checkpoint);
      if (rawCheckpoint) {
        try {
          raw = JSON.parse(rawCheckpoint);
          source = 'checkpoint';
        } catch {
          raw = null;
        }
      }
    }
    if (raw === null && legacyRaw !== undefined) {
      raw = legacyRaw; // 旧版本应用的遗留数据，交给 migrate 补齐
    }

    const { state: migrated, notes } = migrate(raw, createSeedState);

    let outbox: Op[] = [];
    const rawOutbox = this.kv.getItem(this.keys.outbox);
    if (rawOutbox) {
      try {
        const parsed = JSON.parse(rawOutbox);
        if (Array.isArray(parsed)) outbox = parsed;
      } catch {
        outbox = [];
      }
    }

    let state = migrated;
    let replayed = 0;
    let skipped = 0;
    const pending: Op[] = [];
    for (const op of outbox) {
      if (state.appliedOps.includes(op.opId)) {
        skipped++; // 检查点已包含该操作，跳过即幂等
        continue;
      }
      const r = reduce(state, op);
      if (!r.error && r.state !== state) {
        state = r.state;
        replayed++;
        pending.push(op);
      } else {
        skipped++;
      }
    }
    this.outbox = pending;
    return { state, report: { source, replayed, skipped, notes } };
  }

  private persist(): void {
    try {
      const serialized = JSON.stringify(this.state);
      const outboxJson = JSON.stringify(this.outbox);
      if (this.kv.getItem(this.keys.state) === serialized && this.kv.getItem(this.keys.outbox) === outboxJson) {
        this.degraded = false;
        return; // 内容一致就不写，避免多窗口之间互相触发 storage 事件
      }
      this.kv.setItem(this.keys.outbox, outboxJson); // 1. 先记下待重放操作
      this.kv.setItem(this.keys.state, serialized); // 2. 再写主状态
      this.kv.setItem(this.keys.checkpoint, serialized); // 3. 主状态写完整后才推进检查点
      this.kv.setItem(this.keys.outbox, '[]'); // 4. 检查点已覆盖这些操作
      this.outbox = [];
      this.degraded = false;
    } catch {
      // 写入失败：outbox 仍留在存储里，恢复时从最后一个完整检查点重放
      this.degraded = true;
    }
  }
}
