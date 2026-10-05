import { useEffect, useReducer } from 'react';
import { ChainStore, DEFAULT_KEYS, type KVStore, type RecoverReport } from './store';
import type { LicenseStatus, OpResult, Pair } from './types';

/** 浏览器存储适配：支持注入一次写入故障，用于演示检查点恢复 */
class BrowserKV implements KVStore {
  private failNextWrite = false;
  getItem(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }
  setItem(key: string, value: string): void {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error('simulated write failure');
    }
    localStorage.setItem(key, value);
  }
  removeItem(key: string): void {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  }
  failNext(): void {
    this.failNextWrite = true;
  }
}

const kv = new BrowserKV();

/** 旧版本应用把方案存在 'type-pairs'，缺少字体/修订号/授权快照，交给 migrate 补齐 */
function legacyRaw(): unknown {
  try {
    const raw = localStorage.getItem('type-pairs');
    if (!raw) return undefined;
    const pairs = JSON.parse(raw);
    return Array.isArray(pairs) ? { pairs } : undefined;
  } catch {
    return undefined;
  }
}

export const chainStore = new ChainStore(kv, DEFAULT_KEYS, legacyRaw());

let opCounter = 0;
function nextOpId(): string {
  return `op-${Date.now().toString(36)}-${(opCounter++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export const chainActions = {
  savePair(pair: Pair, baseRevision: number): OpResult {
    return chainStore.dispatch({ kind: 'pair.save', opId: nextOpId(), at: Date.now(), pair, baseRevision });
  },
  createPair(title: string): Pair {
    const pair: Pair = {
      id: Date.now(),
      title,
      heading: 'Your new headline',
      body: 'Start with a sentence that lets your type pairing show its character.',
      category: 'Untitled',
      favorite: false,
      headingFont: 'Fraunces',
      bodyFont: 'DM Sans',
      revision: 1,
      updatedAt: Date.now(),
    };
    chainStore.dispatch({ kind: 'pair.create', opId: nextOpId(), at: Date.now(), pair });
    return pair;
  },
  deletePair(pairId: number): OpResult {
    return chainStore.dispatch({ kind: 'pair.delete', opId: nextOpId(), at: Date.now(), pairId });
  },
  setLicense(font: string, status: LicenseStatus): OpResult {
    return chainStore.dispatch({ kind: 'license.set', opId: nextOpId(), at: Date.now(), font, status });
  },
  createBatch(name: string, pairIds: number[]): OpResult {
    return chainStore.dispatch({ kind: 'batch.create', opId: nextOpId(), at: Date.now(), name, pairIds });
  },
  publishBatch(batchId: string): OpResult {
    return chainStore.dispatch({ kind: 'batch.publish', opId: nextOpId(), at: Date.now(), batchId });
  },
  reviewBatch(batchId: string, approve: boolean): OpResult {
    return chainStore.dispatch({ kind: 'batch.review', opId: nextOpId(), at: Date.now(), batchId, approve });
  },
  /** 演示用：让下一次持久化写入失败 */
  injectWriteFailure(): void {
    kv.failNext();
  },
  recover(): RecoverReport {
    return chainStore.recover();
  },
  /** 演示用：写入两条缺授权快照的旧批次（一条可从历史补齐，一条补不全），再触发迁移 */
  importLegacyDemo(): RecoverReport {
    const s = chainStore.getState();
    const pairIds = s.pairs.slice(0, 2).map(p => p.id);
    const legacy = {
      ...s,
      schemaVersion: 1,
      batches: [
        ...s.batches,
        {
          id: `legacy-ok-${Date.now()}`,
          name: '旧版批次 · 快照可补',
          pairIds,
          status: 'published',
          licenseRevision: 1,
          createdAt: Date.now() - 86400000,
          publishedAt: Date.now() - 86400000,
        },
        {
          id: `legacy-bad-${Date.now()}`,
          name: '旧版批次 · 快照缺失',
          pairIds,
          status: 'published',
          licenseRevision: 999,
          createdAt: Date.now() - 172800000,
          publishedAt: Date.now() - 172800000,
        },
      ],
    };
    localStorage.setItem(DEFAULT_KEYS.state, JSON.stringify(legacy));
    return chainStore.recover();
  },
};

/** React 绑定：订阅存储变更，并监听其他窗口的 storage 事件保持同步 */
export function useChain(): ChainStore {
  const [, bump] = useReducer((x: number) => x + 1, 0);
  useEffect(() => chainStore.subscribe(bump), []);
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key && e.key.startsWith('type-pairer:chain')) chainStore.recover();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  return chainStore;
}
