export type LicenseStatus = 'active' | 'revoked';

export type FontSettings = {
  size: number;
  weight: number;
  leading: number;
  tracking: number;
};

export type Pairing = {
  id: string;
  title: string;
  heading: string;
  body: string;
  category: string;
  favorite: boolean;
  headingFont: string;
  bodyFont: string;
  settings: FontSettings;
  revision: number;
  updatedAt: string;
};

export type FontLicense = {
  id: string;
  fontName: string;
  vendor: string;
  scope: string;
  status: LicenseStatus;
  updatedAt: string;
};

export type LicenseSnapshot = {
  id: string;
  fontName: string;
  vendor: string;
  scope: string;
  status: LicenseStatus;
  snapshottedAt: string;
};

export type Violation = {
  code: 'LICENSE_REVOKED' | 'LICENSE_NOT_FOUND' | 'PAIRING_NOT_FOUND';
  slot: 'heading' | 'body' | 'pairing';
  fontName: string;
  licenseId?: string;
  message: string;
  blocking: boolean;
  verificationRequired: boolean;
};

export type BatchReadiness = 'ready' | 'blocked' | 'pending_verification';
export type BatchStatus = 'draft' | 'in_review' | 'published' | 'pending_verification';

export type ReleaseSnapshot = {
  revision: number;
  pairing: Pairing;
  licenses: Record<string, LicenseSnapshot>;
  hash: string;
  publishedAt: string;
};

export type ReleaseBatch = {
  id: string;
  pairingId: string;
  channel: string;
  status: BatchStatus;
  readiness: BatchReadiness;
  violations: Violation[];
  createdAt: string;
  updatedAt: string;
  computedRevision: number;
  snapshot?: ReleaseSnapshot;
  publishedAt?: string;
};

export type ExportRecord = {
  id: string;
  operationId: string;
  batchId: string;
  format: 'CSS';
  fileName: string;
  hash: string;
  fromSnapshot: boolean;
  createdAt: string;
};

export type ActivityItem = {
  id: string;
  revision: number;
  kind: string;
  message: string;
  at: string;
};

export type MigrationReport = {
  source: string;
  status: 'completed' | 'partial' | 'failed';
  total: number;
  ready: number;
  blocked: number;
  pending: number;
  note: string;
  at: string;
};

export type ReleaseState = {
  schemaVersion: 1;
  revision: number;
  pairings: Pairing[];
  licenses: FontLicense[];
  batches: ReleaseBatch[];
  exports: ExportRecord[];
  activity: ActivityItem[];
  migration?: MigrationReport;
  processedEvents: Record<string, string>;
};

export type Command =
  | { type: 'pairing.update'; pairingId: string; fields: Partial<Omit<Pairing, 'id'>> }
  | { type: 'license.toggle'; licenseId: string; status: LicenseStatus }
  | { type: 'license.create'; fontName: string; vendor?: string }
  | { type: 'batch.create'; pairingId: string; channel: string }
  | { type: 'batch.publish'; batchId: string }
  | { type: 'export.css'; batchId: string };

export type ReleaseEvent = {
  id: string;
  at: string;
  revision: number;
} & Command;

export const FONT_OPTIONS = [
  'Fraunces',
  'DM Sans',
  'Space Grotesk',
  'Newsreader',
  'IBM Plex Sans',
  'Playfair Display',
];

export const DEFAULT_SETTINGS: FontSettings = {
  size: 46,
  weight: 600,
  leading: 1.25,
  tracking: 0,
};

type ReductionResult = { state: ReleaseState; skippedDuplicate: boolean };

const seedTime = '2026-10-05T08:30:00.000Z';

export function createEventId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `evt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function hashSnapshot(value: unknown): string {
  const stableStringify = (input: unknown): string => {
    if (input === null || typeof input !== 'object') return JSON.stringify(input) ?? 'null';
    if (Array.isArray(input)) return `[${input.map(stableStringify).join(',')}]`;
    const record = input as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  };
  const json = stableStringify(value);
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < json.length; i += 1) {
    const ch = json.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hash = (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(13, '0');
  return `sha-${hash.slice(0, 13)}`;
}

const fontKey = (fontName: string) => fontName.trim().toLowerCase();

export function findLicense(licenses: FontLicense[], fontName: string): FontLicense | undefined {
  const key = fontKey(fontName);
  return licenses.find((license) => fontKey(license.fontName) === key);
}

function licenseSnapshot(license: FontLicense, at: string, status?: LicenseStatus): LicenseSnapshot {
  return {
    id: license.id,
    fontName: license.fontName,
    vendor: license.vendor,
    scope: license.scope,
    status: status ?? license.status,
    snapshottedAt: at,
  };
}

export function evaluateBatch(
  batch: ReleaseBatch,
  pairing: Pairing | undefined,
  licenses: FontLicense[],
  revision: number,
  at: string,
): ReleaseBatch {
  if (batch.status === 'published') return batch;

  const violations: Violation[] = [];
  if (!pairing) {
    violations.push({
      code: 'PAIRING_NOT_FOUND',
      slot: 'pairing',
      fontName: '',
      message: '批次引用的配对方案不存在，需要人工核对。',
      blocking: true,
      verificationRequired: true,
    });
  } else {
    (['heading', 'body'] as const).forEach((slot) => {
      const fontName = slot === 'heading' ? pairing.headingFont : pairing.bodyFont;
      if (!fontName) {
        violations.push({
          code: 'LICENSE_NOT_FOUND',
          slot,
          fontName: '',
          message: `${slot === 'heading' ? '标题字体' : '正文字体'}缺失，无法补齐授权快照。`,
          blocking: false,
          verificationRequired: true,
        });
        return;
      }
      const license = findLicense(licenses, fontName);
      if (!license) {
        violations.push({
          code: 'LICENSE_NOT_FOUND',
          slot,
          fontName,
          message: `“${fontName}”不在授权清单中，批次停在待核。`,
          blocking: false,
          verificationRequired: true,
        });
      } else if (license.status === 'revoked') {
        violations.push({
          code: 'LICENSE_REVOKED',
          slot,
          fontName,
          licenseId: license.id,
          message: `“${fontName}”授权已撤回，未发布批次必须更换后才能公开。`,
          blocking: true,
          verificationRequired: false,
        });
      }
    });
  }

  const needsVerification = violations.some((item) => item.verificationRequired);
  const blocked = violations.some((item) => item.blocking);
  const readiness: BatchReadiness = needsVerification
    ? 'pending_verification'
    : blocked
      ? 'blocked'
      : 'ready';

  return {
    ...batch,
    readiness,
    violations,
    status: needsVerification ? 'pending_verification' : batch.status === 'pending_verification' ? 'draft' : batch.status,
    computedRevision: revision,
    updatedAt: at,
  };
}

function recomputeUnpublished(state: ReleaseState, revision: number, at: string): void {
  state.batches = state.batches.map((batch) => {
    if (batch.status === 'published') return batch;
    const pairing = state.pairings.find((item) => item.id === batch.pairingId);
    return evaluateBatch(batch, pairing, state.licenses, revision, at);
  });
}

function addActivity(state: ReleaseState, revision: number, kind: string, message: string, at: string, id: string): void {
  state.activity = [{ id: `act-${id}`, revision, kind, message, at }, ...state.activity].slice(0, 24);
}

function makeSnapshot(pairing: Pairing, licenses: FontLicense[], revision: number, at: string, statusFor?: Record<string, LicenseStatus>): ReleaseSnapshot {
  const needed = [pairing.headingFont, pairing.bodyFont].filter(Boolean);
  const snapshots: Record<string, LicenseSnapshot> = {};
  needed.forEach((fontName) => {
    const license = findLicense(licenses, fontName);
    if (license) snapshots[fontName] = licenseSnapshot(license, at, statusFor?.[fontName]);
  });
  const data = { revision, pairing, licenses: snapshots };
  return { ...data, hash: hashSnapshot(data), publishedAt: at };
}

export function buildPublishSnapshot(state: ReleaseState, batch: ReleaseBatch): ReleaseSnapshot {
  const pairing = state.pairings.find((item) => item.id === batch.pairingId);
  if (!pairing) throw new Error('配对方案不存在');
  const dryRun = evaluateBatch(batch, pairing, state.licenses, state.revision, seedTime);
  if (dryRun.readiness !== 'ready') throw new Error(dryRun.violations[0]?.message ?? '批次未通过发布校验');
  return makeSnapshot(pairing, state.licenses, state.revision + 1, new Date().toISOString());
}

function shortId(eventId: string): string {
  return eventId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toUpperCase();
}

export function reduceWithInfo(state: ReleaseState, event: ReleaseEvent): ReductionResult {
  if (state.processedEvents[event.id]) {
    return { state, skippedDuplicate: true };
  }

  const next: ReleaseState = {
    ...state,
    revision: event.revision,
    pairings: state.pairings.map((item) => ({ ...item, settings: { ...item.settings } })),
    licenses: state.licenses.map((item) => ({ ...item })),
    batches: state.batches.map((item) => ({ ...item, violations: [...item.violations] })),
    exports: [...state.exports],
    activity: [...state.activity],
    processedEvents: { ...state.processedEvents, [event.id]: event.type },
  };

  const revision = event.revision;
  const at = event.at;

  switch (event.type) {
    case 'pairing.update': {
      const index = next.pairings.findIndex((item) => item.id === event.pairingId);
      if (index < 0) return { state, skippedDuplicate: false };
      const current = next.pairings[index];
      next.pairings[index] = {
        ...current,
        ...event.fields,
        settings: { ...current.settings, ...(event.fields.settings ?? {}) },
        revision,
        updatedAt: at,
      };
      recomputeUnpublished(next, revision, at);
      addActivity(next, revision, 'pairing', `配对方案「${current.title}」生成修订 r${revision}。`, at, event.id);
      break;
    }
    case 'license.toggle': {
      const license = next.licenses.find((item) => item.id === event.licenseId);
      if (!license) return { state, skippedDuplicate: false };
      const previous = license.status;
      license.status = event.status;
      license.updatedAt = at;
      recomputeUnpublished(next, revision, at);
      addActivity(
        next,
        revision,
        'license',
        `“${license.fontName}”授权由${previous === 'active' ? '有效' : '撤回'}改为${event.status === 'active' ? '有效' : '撤回'}，未发布批次已重算。`,
        at,
        event.id,
      );
      break;
    }
    case 'license.create': {
      const fontName = event.fontName.trim();
      if (!fontName || findLicense(next.licenses, fontName)) break;
      const license: FontLicense = {
        id: `lic-${shortId(event.id)}`,
        fontName,
        vendor: event.vendor?.trim() || '授权供应商待补充',
        scope: '画廊、排版画布、导出样式',
        status: 'active',
        updatedAt: at,
      };
      next.licenses.push(license);
      recomputeUnpublished(next, revision, at);
      addActivity(next, revision, 'license', `已补齐“${fontName}”授权快照并重算待核批次。`, at, event.id);
      break;
    }
    case 'batch.create': {
      const pairing = next.pairings.find((item) => item.id === event.pairingId);
      if (!pairing) break;
      const batch: ReleaseBatch = evaluateBatch(
        {
          id: `B-${shortId(event.id)}`,
          pairingId: pairing.id,
          channel: event.channel,
          status: 'draft',
          readiness: 'ready',
          violations: [],
          createdAt: at,
          updatedAt: at,
          computedRevision: revision,
        },
        pairing,
        next.licenses,
        revision,
        at,
      );
      next.batches.unshift(batch);
      addActivity(next, revision, 'batch', `批次 ${batch.id} 已接入「${pairing.title}」发布链。`, at, event.id);
      break;
    }
    case 'batch.publish': {
      const batch = next.batches.find((item) => item.id === event.batchId);
      const pairing = batch && next.pairings.find((item) => item.id === batch.pairingId);
      if (!batch || !pairing || batch.status === 'published') break;
      const checked = evaluateBatch(batch, pairing, next.licenses, revision, at);
      if (checked.readiness !== 'ready') break;
      const snapshot = makeSnapshot(pairing, next.licenses, revision, at);
      Object.assign(batch, {
        status: 'published' as const,
        readiness: 'ready' as const,
        violations: [],
        snapshot,
        publishedAt: at,
        computedRevision: revision,
        updatedAt: at,
      });
      addActivity(next, revision, 'publish', `批次 ${batch.id} 已公开；快照 ${snapshot.hash} 已冻结。`, at, event.id);
      break;
    }
    case 'export.css': {
      const batch = next.batches.find((item) => item.id === event.batchId);
      const pairing = batch && next.pairings.find((item) => item.id === batch.pairingId);
      if (!batch || !pairing) break;
      if (batch.status !== 'published') {
        const checked = evaluateBatch(batch, pairing, next.licenses, revision, at);
        if (checked.readiness !== 'ready') break;
      }
      const hash = batch.snapshot?.hash ?? makeSnapshot(pairing, next.licenses, revision, at).hash;
      const record: ExportRecord = {
        id: `exp-${shortId(event.id)}`,
        operationId: event.id,
        batchId: batch.id,
        format: 'CSS',
        fileName: `${batch.id.toLowerCase()}-${hash}.css`,
        hash,
        fromSnapshot: Boolean(batch.snapshot),
        createdAt: at,
      };
      next.exports.unshift(record);
      addActivity(next, revision, 'export', `导出记录 ${record.id} 指向 ${hash}。`, at, event.id);
      break;
    }
  }

  return { state: next, skippedDuplicate: false };
}

export function reducer(state: ReleaseState, event: ReleaseEvent): ReleaseState {
  return reduceWithInfo(state, event).state;
}

export function replayEvents(state: ReleaseState, events: ReleaseEvent[]): { state: ReleaseState; duplicates: number } {
  let current = state;
  let duplicates = 0;
  for (const event of events) {
    const result = reduceWithInfo(current, event);
    current = result.state;
    if (result.skippedDuplicate) duplicates += 1;
  }
  return { state: current, duplicates };
}

function license(id: string, fontName: string, vendor: string, status: LicenseStatus, updatedAt: string): FontLicense {
  return { id, fontName, vendor, scope: '画廊、排版画布、导出样式', status, updatedAt };
}

export function createSeedState(): ReleaseState {
  const editorial: Pairing = {
    id: 'pair-editorial',
    title: 'Editorial calm',
    heading: 'A slower way to see',
    body: 'Good typography creates space for ideas to breathe. Pair a confident display face with a quiet, generous text face.',
    category: 'Editorial',
    favorite: true,
    headingFont: 'Fraunces',
    bodyFont: 'DM Sans',
    settings: DEFAULT_SETTINGS,
    revision: 1,
    updatedAt: '2026-09-18T10:00:00.000Z',
  };
  const studio: Pairing = {
    id: 'pair-studio',
    title: 'Studio notes',
    heading: 'Make room for the unexpected',
    body: 'A thoughtful pairing can add rhythm to even the simplest interface.',
    category: 'Portfolio',
    favorite: false,
    headingFont: 'Space Grotesk',
    bodyFont: 'IBM Plex Sans',
    settings: { ...DEFAULT_SETTINGS, size: 42, weight: 500 },
    revision: 1,
    updatedAt: '2026-09-20T10:00:00.000Z',
  };
  const field: Pairing = {
    id: 'pair-field',
    title: 'Field guide',
    heading: 'Small details, lasting impressions',
    body: 'Typography is the voice of a page. Find a combination that feels clear, warm and distinctly yours.',
    category: 'Brand',
    favorite: false,
    headingFont: 'Newsreader',
    bodyFont: 'Playfair Display',
    settings: { ...DEFAULT_SETTINGS, size: 44, weight: 500, leading: 1.3 },
    revision: 2,
    updatedAt: '2026-10-02T09:00:00.000Z',
  };
  const legacy: Pairing = {
    id: 'pair-legacy',
    title: 'Legacy specimen',
    heading: 'A face without a contract',
    body: '旧批次只保存了字体名称，没有授权快照，迁移后必须先核对待用授权。',
    category: 'Archive',
    favorite: false,
    headingFont: 'Foundry Display',
    bodyFont: 'IBM Plex Sans',
    settings: DEFAULT_SETTINGS,
    revision: 1,
    updatedAt: '2026-09-12T10:00:00.000Z',
  };

  const licenses = [
    license('lic-fraunces', 'Fraunces', 'Undertype Cooperative', 'active', '2026-08-01T00:00:00.000Z'),
    license('lic-dm-sans', 'DM Sans', 'Google Fonts', 'active', '2026-08-01T00:00:00.000Z'),
    license('lic-space', 'Space Grotesk', 'Florian Karsten', 'active', '2026-08-01T00:00:00.000Z'),
    license('lic-newsreader', 'Newsreader', 'Google Fonts', 'active', '2026-08-01T00:00:00.000Z'),
    license('lic-ibm', 'IBM Plex Sans', 'IBM', 'active', '2026-08-01T00:00:00.000Z'),
    license('lic-playfair', 'Playfair Display', 'Google Fonts', 'revoked', '2026-10-02T08:00:00.000Z'),
  ];

  const snapshotPairing = { ...field, bodyFont: 'Playfair Display' };
  const publishedSnapshot = makeSnapshot(
    snapshotPairing,
    licenses.map((item) => (item.id === 'lic-playfair' ? { ...item, status: 'active' as LicenseStatus } : item)),
    3,
    '2026-09-21T14:00:00.000Z',
    { 'Playfair Display': 'active' },
  );

  const base = {
    channel: '画廊 / 排版画布 / 导出样式',
    createdAt: seedTime,
    updatedAt: seedTime,
  };
  const published: ReleaseBatch = {
    ...base,
    id: 'B-2391',
    pairingId: field.id,
    status: 'published',
    readiness: 'ready',
    violations: [],
    computedRevision: 3,
    snapshot: publishedSnapshot,
    publishedAt: '2026-09-21T14:00:00.000Z',
  };
  const readyDraft: ReleaseBatch = evaluateBatch(
    { ...base, id: 'B-2401', pairingId: editorial.id, status: 'draft', readiness: 'ready', violations: [], computedRevision: 4 },
    editorial,
    licenses,
    4,
    seedTime,
  );
  const blockedDraft: ReleaseBatch = evaluateBatch(
    { ...base, id: 'B-2402', pairingId: field.id, status: 'draft', readiness: 'ready', violations: [], computedRevision: 5 },
    field,
    licenses,
    5,
    seedTime,
  );
  const pendingBatch: ReleaseBatch = evaluateBatch(
    { ...base, id: 'B-2403', pairingId: legacy.id, status: 'draft', readiness: 'ready', violations: [], computedRevision: 5 },
    legacy,
    licenses,
    5,
    seedTime,
  );

  return {
    schemaVersion: 1,
    revision: 5,
    pairings: [editorial, studio, field, legacy],
    licenses,
    batches: [pendingBatch, blockedDraft, readyDraft, published],
    exports: [
      {
        id: 'exp-seed-2391',
        operationId: 'seed-export-2391',
        batchId: published.id,
        format: 'CSS',
        fileName: 'b-2391-public-snapshot.css',
        hash: publishedSnapshot.hash,
        fromSnapshot: true,
        createdAt: '2026-09-21T14:05:00.000Z',
      },
    ],
    activity: [
      { id: 'act-seed-5', revision: 5, kind: 'license', message: 'Playfair Display 授权撤回；未发布批次 B-2402 已重算为阻断。', at: '2026-10-02T08:00:00.000Z' },
      { id: 'act-seed-3', revision: 3, kind: 'publish', message: 'B-2391 已公开，发布时授权快照已冻结。', at: '2026-09-21T14:00:00.000Z' },
      { id: 'act-seed-1', revision: 1, kind: 'chain', message: '发布链种子数据已创建。', at: '2026-09-18T10:00:00.000Z' },
    ],
    processedEvents: { 'seed-export-2391': 'export.css' },
  };
}

type LegacyPair = {
  id?: number | string;
  title?: string;
  heading?: string;
  body?: string;
  category?: string;
  favorite?: boolean;
  headingFont?: unknown;
  bodyFont?: unknown;
};

function asFontName(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

export function migrateLegacyPairs(raw: string): ReleaseState {
  const at = new Date().toISOString();
  let legacyPairs: LegacyPair[];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('legacy record is not an array');
    legacyPairs = parsed;
  } catch {
    const state = createSeedState();
    return {
      ...state,
      migration: {
        source: 'type-pairs',
        status: 'failed',
        total: 0,
        ready: 0,
        blocked: 0,
        pending: 0,
        note: '旧数据无法解析，已保留在待核区，未覆盖现有发布链。',
        at,
      },
    };
  }

  const seed = createSeedState();
  const pairings: Pairing[] = [];
  const batches: ReleaseBatch[] = [];

  legacyPairs.forEach((legacy, index) => {
    const id = `legacy-${legacy.id ?? index + 1}`;
    // The previous schema stored no font fields. Only id=1 had a known,
    // auditable mapping; everything else must stop in verification.
    const headingFont = asFontName(legacy.headingFont) || (legacy.id === 1 ? 'Fraunces' : '');
    const bodyFont = asFontName(legacy.bodyFont) || (legacy.id === 1 ? 'DM Sans' : '');
    const pairing: Pairing = {
      id,
      title: typeof legacy.title === 'string' && legacy.title ? legacy.title : `Legacy pairing ${index + 1}`,
      heading: typeof legacy.heading === 'string' ? legacy.heading : 'Legacy headline',
      body: typeof legacy.body === 'string' ? legacy.body : 'Legacy body copy.',
      category: typeof legacy.category === 'string' ? legacy.category : 'Legacy',
      favorite: Boolean(legacy.favorite),
      headingFont,
      bodyFont,
      settings: DEFAULT_SETTINGS,
      revision: 1,
      updatedAt: at,
    };
    pairings.push(pairing);
    batches.push(
      evaluateBatch(
        {
          id: `MIG-${String(legacy.id ?? index + 1).padStart(3, '0')}`,
          pairingId: id,
          channel: '旧稿迁移 / 待核',
          status: 'draft',
          readiness: 'ready',
          violations: [],
          createdAt: at,
          updatedAt: at,
          computedRevision: 1,
        },
        pairing,
        seed.licenses,
        1,
        at,
      ),
    );
  });

  const pending = batches.filter((batch) => batch.readiness === 'pending_verification').length;
  const blocked = batches.filter((batch) => batch.readiness === 'blocked').length;
  const ready = batches.length - pending - blocked;
  const state: ReleaseState = {
    ...seed,
    revision: 1,
    pairings,
    batches,
    exports: [],
    activity: [
      {
        id: 'act-migration',
        revision: 1,
        kind: 'migration',
        message: `旧版 type-pairs 已迁移：${ready} 条可发布，${pending} 条待核，${blocked} 条授权阻断。`,
        at,
      },
    ],
    processedEvents: {},
    migration: {
      source: 'type-pairs',
      status: pending || blocked ? 'partial' : 'completed',
      total: batches.length,
      ready,
      blocked,
      pending,
      note: pending ? '缺少授权快照的旧批次已停在待核；补齐授权后会自动重算。' : '全部旧批次均已补齐授权快照。',
      at,
    },
  };
  return state;
}

export function batchCss(state: ReleaseState, batchId: string): string | undefined {
  const batch = state.batches.find((item) => item.id === batchId);
  if (!batch) return undefined;
  const currentPairing = state.pairings.find((item) => item.id === batch.pairingId);
  const pairing = batch.snapshot?.pairing ?? currentPairing;
  if (!pairing) return undefined;
  const licenses = batch.snapshot?.licenses ?? null;
  const licenseLine = (fontName: string) => {
 if (licenses) return `${fontName}: ${licenses[fontName]?.status ?? 'unknown'} @ snapshot`;
    const license = findLicense(state.licenses, fontName);
    return `${fontName}: ${license ? license.status : 'license not found'} @ r${state.revision}`;
  };

  return [
    `/* ${batch.id} — ${pairing.title} */`,
    batch.snapshot
      ? `/* Public immutable snapshot r${batch.snapshot.revision} · ${batch.snapshot.hash} */`
      : `/* Unpublished provisional export r${state.revision} · recomputed against current license list */`,
    `/* ${licenseLine(pairing.headingFont)} */`,
    `/* ${licenseLine(pairing.bodyFont)} */`,
    `.heading { font-family: '${pairing.headingFont}'; font-size: ${pairing.settings.size}px; font-weight: ${pairing.settings.weight}; line-height: 1.05; }`,
    `.body { font-family: '${pairing.bodyFont}'; font-size: 15px; line-height: ${pairing.settings.leading}; letter-spacing: ${pairing.settings.tracking / 2}px; }`,
    '',
  ].join('\n');
}

export type ConflictField = {
  path: string;
  label: string;
  localValue: string;
  remoteValue: string;
  localChanged: boolean;
  remoteChanged: boolean;
  conflicting: boolean;
};

const fieldLabels: Record<string, string> = {
  title: '方案名称',
  heading: '标题文案',
  body: '正文文案',
  favorite: '收藏',
  headingFont: '标题字体',
  bodyFont: '正文字体',
  category: '分类',
  'settings.size': '字号',
  'settings.weight': '字重',
  'settings.leading': '行高',
  'settings.tracking': '字距',
};

function scalar(value: unknown): string {
  if (value === undefined || value === null) return '';
  return String(value);
}

export function pairingConflicts(base: Pairing, latest: Pairing, local: Pairing): ConflictField[] {
  const fields = Object.keys(fieldLabels);
  return fields.map((path) => {
    const get = (pairing: Pairing) =>
      path.startsWith('settings.')
        ? scalar(pairing.settings[path.split('.')[1] as keyof FontSettings])
        : scalar(pairing[path as keyof Pairing]);
    const baseValue = get(base);
    const remoteValue = get(latest);
    const localValue = get(local);
    const remoteChanged = baseValue !== remoteValue;
    const localChanged = baseValue !== localValue;
    return {
      path,
      label: fieldLabels[path],
      localValue,
      remoteValue,
      localChanged,
      remoteChanged,
      conflicting: localChanged && remoteChanged && localValue !== remoteValue,
    };
  });
}

export function rebaseDraft(base: Pairing, latest: Pairing, local: Pairing): Pairing {
  const changed = pairingConflicts(base, latest, local)
    .filter((field) => field.localChanged && !field.conflicting)
    .map((field) => field.path);
  const settings = { ...latest.settings };
  const fields: Partial<Pairing> = { ...latest };
  changed.forEach((path) => {
    if (path.startsWith('settings.')) {
      const key = path.split('.')[1] as keyof FontSettings;
      settings[key] = local.settings[key];
    } else {
      const key = path as keyof Pairing;
      (fields as Record<string, unknown>)[key] = local[key];
    }
  });
  return { ...latest, ...fields, id: latest.id, settings };
}
