import type {
  Batch,
  ChainError,
  ChainState,
  ConflictField,
  ExportRecord,
  LicenseMap,
  LicenseSnapshot,
  Op,
  OpResult,
  Pair,
} from './types';

export const SCHEMA_VERSION = 2;
export const KNOWN_FONTS = ['Fraunces', 'DM Sans', 'Space Grotesk', 'Newsreader', 'IBM Plex Sans', 'Playfair Display'];

/** 参与冲突比对的方案字段（修订号、时间戳除外） */
const PAIR_EDITABLE_FIELDS: (keyof Pair)[] = ['title', 'heading', 'body', 'category', 'favorite', 'headingFont', 'bodyFont'];
const HISTORY_LIMIT = 30;
const APPLIED_OPS_LIMIT = 1000;

export function usedFonts(pairs: Pair[], pairIds: number[]): string[] {
  const set = new Set<string>();
  for (const id of pairIds) {
    const p = pairs.find(x => x.id === id);
    if (p) {
      set.add(p.headingFont);
      set.add(p.bodyFont);
    }
  }
  return [...set];
}

export function blockedFontsFor(pairs: Pair[], pairIds: number[], fonts: LicenseMap): string[] {
  return usedFonts(pairs, pairIds).filter(f => fonts[f] === 'revoked');
}

export function cssForPair(pair: Pair): string {
  return `/* ${pair.title} */\n.heading { font-family: '${pair.headingFont}'; }\n.body { font-family: '${pair.bodyFont}'; }`;
}

/** 授权清单或方案字体变化后，重算所有未发布批次；已发布批次保留快照不动 */
function recomputeOpenBatches(state: ChainState): ChainState {
  return {
    ...state,
    batches: state.batches.map(b =>
      b.status === 'published'
        ? b
        : { ...b, licenseRevision: state.licenses.revision, blockedFonts: blockedFontsFor(state.pairs, b.pairIds, state.licenses.fonts) },
    ),
  };
}

function capHistory(history: Record<number, LicenseMap>): Record<number, LicenseMap> {
  const revs = Object.keys(history).map(Number).sort((a, b) => b - a);
  const capped: Record<number, LicenseMap> = {};
  for (const r of revs.slice(0, HISTORY_LIMIT)) capped[r] = history[r];
  return capped;
}

function publishExports(state: ChainState, batch: Batch, opId: string, at: number, licenseRevision: number): ExportRecord[] {
  const records: ExportRecord[] = [];
  for (const pairId of batch.pairIds) {
    const pair = state.pairs.find(p => p.id === pairId);
    if (!pair) continue;
    // 同一批次同一方案只导出一次：重放、重复审核都不会生成重复记录
    if (state.exports.some(e => e.batchId === batch.id && e.pairId === pairId)) continue;
    records.push({
      id: `exp:${opId}:${pairId}`,
      batchId: batch.id,
      pairId,
      pairTitle: pair.title,
      css: cssForPair(pair),
      licenseRevision,
      createdAt: at,
    });
  }
  return records;
}

/**
 * 状态机：所有变更经由 Op 应用。
 * 已应用过的 opId 直接跳过（幂等），这是检查点重放不重复生成发布记录的第一道保证。
 */
export function reduce(state: ChainState, op: Op): OpResult {
  if (state.appliedOps.includes(op.opId)) return { state, error: null };

  let result: OpResult;
  switch (op.kind) {
    case 'pair.create': {
      if (state.pairs.some(p => p.id === op.pair.id)) return { state, error: null };
      result = { state: { ...state, pairs: [...state.pairs, op.pair] }, error: null };
      break;
    }

    case 'pair.delete': {
      if (!state.pairs.some(p => p.id === op.pairId)) return { state, error: null };
      const pairs = state.pairs.filter(p => p.id !== op.pairId);
      const batches = state.batches.map(b =>
        b.pairIds.includes(op.pairId) ? { ...b, pairIds: b.pairIds.filter(id => id !== op.pairId) } : b,
      );
      result = { state: recomputeOpenBatches({ ...state, pairs, batches }), error: null };
      break;
    }

    case 'pair.save': {
      const current = state.pairs.find(p => p.id === op.pair.id);
      if (!current) {
        result = { state, error: { type: 'pair-not-found', pairId: op.pair.id } };
        break;
      }
      // 只接受基于最新修订号的提交；落后窗口的改动随错误返回，由界面保留
      if (op.baseRevision !== current.revision) {
        const fields: ConflictField[] = PAIR_EDITABLE_FIELDS.filter(f => current[f] !== op.pair[f]).map(f => ({
          field: f,
          incoming: op.pair[f],
          current: current[f],
        }));
        result = {
          state,
          error: { type: 'pair-conflict', pairId: current.id, baseRevision: op.baseRevision, currentRevision: current.revision, fields, incoming: op.pair },
        };
        break;
      }
      const saved: Pair = { ...op.pair, revision: current.revision + 1, updatedAt: op.at };
      result = { state: recomputeOpenBatches({ ...state, pairs: state.pairs.map(p => (p.id === saved.id ? saved : p)) }), error: null };
      break;
    }

    case 'license.set': {
      if (state.licenses.fonts[op.font] === op.status) return { state, error: null };
      const fonts: LicenseMap = { ...state.licenses.fonts, [op.font]: op.status };
      const revision = state.licenses.revision + 1;
      const licenseHistory = capHistory({ ...state.licenseHistory, [revision]: fonts });
      result = {
        state: recomputeOpenBatches({ ...state, licenses: { revision, fonts, updatedAt: op.at }, licenseHistory }),
        error: null,
      };
      break;
    }

    case 'batch.create': {
      const batch: Batch = {
        id: `batch:${op.opId}`,
        name: op.name,
        pairIds: [...op.pairIds],
        status: 'draft',
        licenseRevision: state.licenses.revision,
        blockedFonts: blockedFontsFor(state.pairs, op.pairIds, state.licenses.fonts),
        snapshot: null,
        createdAt: op.at,
        publishedAt: null,
      };
      result = { state: { ...state, batches: [...state.batches, batch] }, error: null };
      break;
    }

    case 'batch.publish': {
      const batch = state.batches.find(b => b.id === op.batchId);
      if (!batch) {
        result = { state, error: { type: 'batch-not-found', batchId: op.batchId } };
        break;
      }
      // 已发布是终态：重复发布（含重放）不再产生任何记录
      if (batch.status === 'published') return { state, error: null };
      if (batch.status === 'pending-review') {
        result = { state, error: { type: 'batch-not-draft', batchId: batch.id } };
        break;
      }
      if (batch.blockedFonts.length > 0) {
        result = { state, error: { type: 'batch-blocked', batchId: batch.id, fonts: batch.blockedFonts } };
        break;
      }
      const snapshot: LicenseSnapshot = { licenseRevision: state.licenses.revision, fonts: { ...state.licenses.fonts }, capturedAt: op.at };
      const published: Batch = { ...batch, status: 'published', snapshot, publishedAt: op.at };
      const records = publishExports(state, batch, op.opId, op.at, snapshot.licenseRevision);
      result = {
        state: { ...state, batches: state.batches.map(b => (b.id === batch.id ? published : b)), exports: [...state.exports, ...records] },
        error: null,
      };
      break;
    }

    case 'batch.review': {
      const batch = state.batches.find(b => b.id === op.batchId);
      if (!batch) {
        result = { state, error: { type: 'batch-not-found', batchId: op.batchId } };
        break;
      }
      if (batch.status !== 'pending-review') return { state, error: null };
      if (op.approve) {
        // 核准：以当前授权清单补齐快照，批次恢复为已公开
        const snapshot: LicenseSnapshot = { licenseRevision: state.licenses.revision, fonts: { ...state.licenses.fonts }, capturedAt: op.at };
        const approved: Batch = { ...batch, status: 'published', snapshot, publishedAt: batch.publishedAt ?? op.at };
        const records = publishExports(state, batch, op.opId, op.at, snapshot.licenseRevision);
        result = {
          state: { ...state, batches: state.batches.map(b => (b.id === batch.id ? approved : b)), exports: [...state.exports, ...records] },
          error: null,
        };
      } else {
        // 退回：回到草稿并立即按当前清单重算
        const draft: Batch = {
          ...batch,
          status: 'draft',
          snapshot: null,
          publishedAt: null,
          licenseRevision: state.licenses.revision,
          blockedFonts: blockedFontsFor(state.pairs, batch.pairIds, state.licenses.fonts),
        };
        result = { state: { ...state, batches: state.batches.map(b => (b.id === batch.id ? draft : b)) }, error: null };
      }
      break;
    }
  }

  if (!result.error && result.state !== state) {
    result = { ...result, state: { ...result.state, appliedOps: [...result.state.appliedOps, op.opId].slice(-APPLIED_OPS_LIMIT) } };
  }
  return result;
}

// ---------- 旧数据迁移 ----------

function normalizePair(raw: Partial<Pair> & { id?: number }, index: number, notes: string[]): Pair {
  const pair: Pair = {
    id: typeof raw.id === 'number' ? raw.id : index + 1,
    title: raw.title ?? `未命名方案 ${index + 1}`,
    heading: raw.heading ?? '',
    body: raw.body ?? '',
    category: raw.category ?? 'Untitled',
    favorite: Boolean(raw.favorite),
    headingFont: raw.headingFont ?? 'Fraunces',
    bodyFont: raw.bodyFont ?? 'DM Sans',
    revision: typeof raw.revision === 'number' ? raw.revision : 1,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
  };
  if (typeof raw.revision !== 'number' || !raw.headingFont || !raw.bodyFont) {
    notes.push(`方案「${pair.title}」缺少字体/修订号，已按默认值补齐`);
  }
  return pair;
}

function normalizeBatch(
  raw: Partial<Batch> & { id?: string },
  index: number,
  licenses: ChainState['licenses'],
  history: Record<number, LicenseMap>,
  pairs: Pair[],
  notes: string[],
): Batch {
  const batch: Batch = {
    id: raw.id ?? `batch:legacy-${index}`,
    name: raw.name ?? `旧批次 ${index + 1}`,
    pairIds: Array.isArray(raw.pairIds) ? raw.pairIds.filter((id): id is number => typeof id === 'number') : [],
    status: raw.status === 'published' || raw.status === 'pending-review' ? raw.status : 'draft',
    licenseRevision: typeof raw.licenseRevision === 'number' ? raw.licenseRevision : licenses.revision,
    blockedFonts: Array.isArray(raw.blockedFonts) ? raw.blockedFonts : [],
    snapshot: raw.snapshot ?? null,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : 0,
    publishedAt: typeof raw.publishedAt === 'number' ? raw.publishedAt : null,
  };

  if (batch.status === 'published' && !batch.snapshot) {
    // 旧数据缺少授权快照：先按批次记录的清单修订号从历史补齐
    const historic = history[batch.licenseRevision];
    if (historic) {
      batch.snapshot = { licenseRevision: batch.licenseRevision, fonts: { ...historic }, capturedAt: batch.publishedAt ?? 0 };
      notes.push(`批次「${batch.name}」授权快照已从清单历史 v${batch.licenseRevision} 补齐`);
    } else {
      // 补不全的停在待核，等待人工确认
      batch.status = 'pending-review';
      notes.push(`批次「${batch.name}」授权快照缺失且无法补齐，已转入待核`);
    }
  }
  if (batch.status !== 'published') {
    batch.licenseRevision = licenses.revision;
    batch.blockedFonts = blockedFontsFor(pairs, batch.pairIds, licenses.fonts);
  }
  return batch;
}

/** 把任意历史形态的数据迁移到当前 schema；无法识别的输入回退到种子数据 */
export function migrate(raw: unknown, seed: () => ChainState): { state: ChainState; notes: string[] } {
  const notes: string[] = [];
  if (!raw || typeof raw !== 'object') {
    return { state: seed(), notes: raw == null ? notes : ['数据无法识别，已回退到初始数据'] };
  }
  const obj = raw as Partial<ChainState>;

  let licenses: ChainState['licenses'];
  if (obj.licenses && obj.licenses.fonts && typeof obj.licenses.revision === 'number') {
    licenses = { revision: obj.licenses.revision, fonts: { ...obj.licenses.fonts }, updatedAt: obj.licenses.updatedAt ?? 0 };
  } else {
    licenses = { revision: 1, fonts: Object.fromEntries(KNOWN_FONTS.map(f => [f, 'active'])), updatedAt: 0 };
    notes.push('缺少授权清单，已按全部字体有效重建');
  }
  const licenseHistory: Record<number, LicenseMap> =
    obj.licenseHistory && typeof obj.licenseHistory === 'object' ? { ...obj.licenseHistory } : { [licenses.revision]: { ...licenses.fonts } };

  const pairs = (Array.isArray(obj.pairs) ? obj.pairs : []).map((p, i) => normalizePair(p ?? {}, i, notes));
  const batches = (Array.isArray(obj.batches) ? obj.batches : []).map((b, i) =>
    normalizeBatch(b ?? {}, i, licenses, licenseHistory, pairs, notes),
  );

  return {
    state: {
      schemaVersion: SCHEMA_VERSION,
      licenses,
      licenseHistory,
      pairs,
      batches,
      exports: Array.isArray(obj.exports) ? obj.exports : [],
      appliedOps: Array.isArray(obj.appliedOps) ? obj.appliedOps.filter((x): x is string => typeof x === 'string') : [],
    },
    notes,
  };
}
