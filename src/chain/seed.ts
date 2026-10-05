import { KNOWN_FONTS, SCHEMA_VERSION, cssForPair } from './engine';
import type { Batch, ChainState, ExportRecord, LicenseMap, Pair } from './types';

/** 首次启动（或数据完全缺失）时的初始发布链状态 */
export function createSeedState(now = Date.now()): ChainState {
  const fonts: LicenseMap = Object.fromEntries(KNOWN_FONTS.map(f => [f, 'active']));
  const pairs: Pair[] = [
    {
      id: 1,
      title: 'Editorial calm',
      heading: 'A slower way to see',
      body: 'Good typography creates space for ideas to breathe. Pair a confident display face with a quiet, generous text face.',
      category: 'Editorial',
      favorite: true,
      headingFont: 'Fraunces',
      bodyFont: 'DM Sans',
      revision: 1,
      updatedAt: now,
    },
    {
      id: 2,
      title: 'Studio notes',
      heading: 'Make room for the unexpected',
      body: 'A thoughtful pairing can add rhythm to even the simplest interface. Try contrast in shape, not just size.',
      category: 'Portfolio',
      favorite: false,
      headingFont: 'Space Grotesk',
      bodyFont: 'DM Sans',
      revision: 1,
      updatedAt: now,
    },
    {
      id: 3,
      title: 'Field guide',
      heading: 'Small details, lasting impressions',
      body: 'Typography is the voice of a page. Find a combination that feels clear, warm and distinctly yours.',
      category: 'Brand',
      favorite: false,
      headingFont: 'Newsreader',
      bodyFont: 'IBM Plex Sans',
      revision: 1,
      updatedAt: now,
    },
  ];
  const publishedBatch: Batch = {
    id: 'batch:seed-published',
    name: '官网首页批次',
    pairIds: [1, 2],
    status: 'published',
    licenseRevision: 1,
    blockedFonts: [],
    snapshot: { licenseRevision: 1, fonts: { ...fonts }, capturedAt: now },
    createdAt: now,
    publishedAt: now,
  };
  const draftBatch: Batch = {
    id: 'batch:seed-draft',
    name: '秋季活动预告',
    pairIds: [1, 3],
    status: 'draft',
    licenseRevision: 1,
    blockedFonts: [],
    snapshot: null,
    createdAt: now,
    publishedAt: null,
  };
  const exports: ExportRecord[] = publishedBatch.pairIds.map(pairId => {
    const pair = pairs.find(p => p.id === pairId)!;
    return {
      id: `exp:seed-publish:${pairId}`,
      batchId: publishedBatch.id,
      pairId,
      pairTitle: pair.title,
      css: cssForPair(pair),
      licenseRevision: 1,
      createdAt: now,
    };
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    licenses: { revision: 1, fonts, updatedAt: now },
    licenseHistory: { 1: { ...fonts } },
    pairs,
    batches: [publishedBatch, draftBatch],
    exports,
    appliedOps: ['seed-publish'],
  };
}
