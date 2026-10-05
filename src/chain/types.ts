// 发布链领域模型：配对方案 → 字体授权 → 发布批次 → 导出记录

export type LicenseStatus = 'active' | 'revoked';
export type LicenseMap = Record<string, LicenseStatus>;

/** 字体授权清单：整体有修订号，任何字体状态变化都会推进 revision */
export interface LicenseList {
  revision: number;
  fonts: LicenseMap;
  updatedAt: number;
}

/** 配对方案：revision 用于乐观并发控制 */
export interface Pair {
  id: number;
  title: string;
  heading: string;
  body: string;
  category: string;
  favorite: boolean;
  headingFont: string;
  bodyFont: string;
  revision: number;
  updatedAt: number;
}

export type BatchStatus = 'draft' | 'published' | 'pending-review';

/** 发布时捕获的授权快照，已公开批次以此为准，不再随清单变化 */
export interface LicenseSnapshot {
  licenseRevision: number;
  fonts: LicenseMap;
  capturedAt: number;
}

/** 发布批次：未发布批次跟随授权清单重算，已发布批次锁定快照 */
export interface Batch {
  id: string;
  name: string;
  pairIds: number[];
  status: BatchStatus;
  /** 本批次最近一次重算所基于的清单修订号 */
  licenseRevision: number;
  /** 批次内方案用到、但授权已撤回的字体 */
  blockedFonts: string[];
  snapshot: LicenseSnapshot | null;
  createdAt: number;
  publishedAt: number | null;
}

/** 导出记录：id 由发布操作派生，保证重放幂等 */
export interface ExportRecord {
  id: string;
  batchId: string;
  pairId: number;
  pairTitle: string;
  css: string;
  licenseRevision: number;
  createdAt: number;
}

export interface ChainState {
  schemaVersion: number;
  licenses: LicenseList;
  /** 清单历史（有界），用于旧批次快照迁移补齐 */
  licenseHistory: Record<number, LicenseMap>;
  pairs: Pair[];
  batches: Batch[];
  exports: ExportRecord[];
  /** 已应用的操作 id，重放时跳过，避免重复生成发布记录 */
  appliedOps: string[];
}

/** 所有状态变更都建模为带 opId 的操作，可持久化、可重放 */
export type Op =
  | { kind: 'pair.create'; opId: string; at: number; pair: Pair }
  | { kind: 'pair.save'; opId: string; at: number; pair: Pair; baseRevision: number }
  | { kind: 'pair.delete'; opId: string; at: number; pairId: number }
  | { kind: 'license.set'; opId: string; at: number; font: string; status: LicenseStatus }
  | { kind: 'batch.create'; opId: string; at: number; name: string; pairIds: number[] }
  | { kind: 'batch.publish'; opId: string; at: number; batchId: string }
  | { kind: 'batch.review'; opId: string; at: number; batchId: string; approve: boolean };

export interface ConflictField {
  field: string;
  incoming: unknown;
  current: unknown;
}

export type ChainError =
  | { type: 'pair-conflict'; pairId: number; baseRevision: number; currentRevision: number; fields: ConflictField[]; incoming: Pair }
  | { type: 'pair-not-found'; pairId: number }
  | { type: 'batch-not-found'; batchId: string }
  | { type: 'batch-blocked'; batchId: string; fonts: string[] }
  | { type: 'batch-not-draft'; batchId: string };

export interface OpResult {
  state: ChainState;
  error: ChainError | null;
}
