import { migrate, reduce } from './engine';
import { createSeedState } from './seed';
import { ChainStore, MemoryKV, type StoreKeys } from './store';
import type { ChainState, Op } from './types';

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`, detail === undefined ? '' : JSON.stringify(detail));
  }
}

const KEYS: StoreKeys = { state: 't:state', checkpoint: 't:checkpoint', outbox: 't:outbox' };
let seq = 0;
const opId = () => `test-op-${++seq}`;
const at = 1700000000000;

function publishOp(batchId: string): Op {
  return { kind: 'batch.publish', opId: opId(), at, batchId };
}

// ---------- 1. 授权变更：未发布批次重算，已发布批次保留快照 ----------
{
  console.log('license change recomputes open batches only');
  const seed = createSeedState(at);
  const r = reduce(seed, { kind: 'license.set', opId: opId(), at, font: 'Fraunces', status: 'revoked' });
  const s = r.state;
  check('no error', r.error === null);
  check('license revision bumped', s.licenses.revision === 2);
  const draft = s.batches.find(b => b.id === 'batch:seed-draft')!;
  const published = s.batches.find(b => b.id === 'batch:seed-published')!;
  check('draft recomputed to new revision', draft.licenseRevision === 2);
  check('draft blocked fonts include Fraunces', draft.blockedFonts.includes('Fraunces'));
  check('published batch keeps snapshot revision', published.snapshot?.licenseRevision === 1);
  check('published batch revision untouched', published.licenseRevision === 1);
  check('published batch not blocked', published.blockedFonts.length === 0);
  check('history recorded', s.licenseHistory[2]?.Fraunces === 'revoked');
}

// ---------- 2. 含撤回字体的批次不能发布 ----------
{
  console.log('publish refused when fonts revoked');
  let s = createSeedState(at);
  s = reduce(s, { kind: 'license.set', opId: opId(), at, font: 'Fraunces', status: 'revoked' }).state;
  const before = s.exports.length;
  const r = reduce(s, publishOp('batch:seed-draft'));
  check('blocked error', r.error?.type === 'batch-blocked');
  check('no exports generated', r.state.exports.length === before);
  check('batch still draft', r.state.batches.find(b => b.id === 'batch:seed-draft')!.status === 'draft');
}

// ---------- 3. 修订号并发：只接受最新修订号，落后方拿到冲突字段 ----------
{
  console.log('optimistic concurrency on pair.save');
  const seed = createSeedState(at);
  const pair = seed.pairs[0];
  // 窗口 A 基于 rev 1 提交成功
  const a = reduce(seed, { kind: 'pair.save', opId: opId(), at, pair: { ...pair, category: 'A 窗口' }, baseRevision: 1 });
  check('window A accepted', a.error === null);
  const afterA = a.state.pairs[0];
  check('revision bumped to 2', afterA.revision === 2);
  // 窗口 B 仍基于 rev 1 提交 → 拒绝，改动保留在 error.incoming
  const b = reduce(a.state, { kind: 'pair.save', opId: opId(), at, pair: { ...pair, title: 'B 窗口标题', headingFont: 'Newsreader' }, baseRevision: 1 });
  check('window B rejected', b.error?.type === 'pair-conflict');
  if (b.error?.type === 'pair-conflict') {
    const fields = b.error.fields.map(f => f.field);
    check('conflict lists title', fields.includes('title'), fields);
    check('conflict lists headingFont', fields.includes('headingFont'), fields);
    check('conflict lists category (differs from current)', fields.includes('category'), fields);
    check('incoming changes preserved', b.error.incoming.title === 'B 窗口标题');
    check('reports current revision', b.error.currentRevision === 2);
  }
  check('state keeps window A values', b.state.pairs[0].category === 'A 窗口');
  // 窗口 B 改用最新修订号重提 → 接受
  const retry = reduce(a.state, { kind: 'pair.save', opId: opId(), at, pair: { ...pair, title: 'B 窗口标题' }, baseRevision: 2 });
  check('retry with latest revision accepted', retry.error === null && retry.state.pairs[0].revision === 3);
}

// ---------- 4. 发布幂等：同一操作重放不重复生成导出记录 ----------
{
  console.log('publish is idempotent');
  const seed = createSeedState(at);
  const op = publishOp('batch:seed-draft');
  const once = reduce(seed, op).state;
  const twice = reduce(once, op).state; // 同一 opId 重放
  check('first publish generates exports', once.exports.length === seed.exports.length + 2);
  check('replay adds nothing', twice.exports.length === once.exports.length);
  check('replay returns same state', twice === once);
  // 不同 opId 重复发布同一批次：批次已是终态，同样无新增
  const again = reduce(once, publishOp('batch:seed-draft')).state;
  check('second publish of published batch is no-op', again.exports.length === once.exports.length);
}

// ---------- 5. 写入失败 → 检查点恢复 → 重放不重复 ----------
{
  console.log('checkpoint recovery with idempotent replay');
  const kv = new MemoryKV();
  const store = new ChainStore(kv, KEYS);
  store.dispatch({ kind: 'license.set', opId: opId(), at, font: 'DM Sans', status: 'revoked' });
  const exportsBefore = store.getState().exports.length;

  // 模拟：主状态写坏（检查点仍是上一个完整版本），outbox 里留有未确认操作
  const pendingOp: Op = { kind: 'license.set', opId: opId(), at, font: 'Fraunces', status: 'revoked' };
  kv.setItem(KEYS.outbox, JSON.stringify([pendingOp]));
  kv.setItem(KEYS.state, '{"broken":');

  const report = store.recover();
  check('restored from checkpoint', report.source === 'checkpoint');
  check('replayed pending op', report.replayed === 1, report);
  check(' Fraunces revoked after replay', store.getState().licenses.fonts.Fraunces === 'revoked');
  check('no duplicate exports', store.getState().exports.length === exportsBefore);

  // 再恢复一次：操作已在检查点里，全部跳过
  const report2 = store.recover();
  check('second recovery replays nothing', report2.replayed === 0, report2);
  check('exports still unchanged', store.getState().exports.length === exportsBefore);

  // 模拟：检查点已包含发布操作，但 outbox 清空失败 → 重放时按 opId 跳过
  const kv2 = new MemoryKV();
  const store2 = new ChainStore(kv2, KEYS);
  const pub: Op = publishOp('batch:seed-draft');
  store2.dispatch(pub);
  const exportsAfterPublish = store2.getState().exports.length;
  kv2.setItem(KEYS.outbox, JSON.stringify([pub])); // 崩溃发生在清空 outbox 之前
  const report3 = store2.recover();
  check('already-applied op skipped', report3.skipped === 1 && report3.replayed === 0, report3);
  check('publish not duplicated', store2.getState().exports.length === exportsAfterPublish);
}

// ---------- 6. 旧数据迁移：快照补齐，补不全的停在待核 ----------
{
  console.log('migration backfills snapshots or parks at pending-review');
  const legacy = {
    pairs: [{ id: 1, title: '旧方案', heading: 'hi', body: 'text', category: 'Legacy', favorite: false }],
    licenses: { revision: 2, fonts: { Fraunces: 'active', 'DM Sans': 'revoked' }, updatedAt: at },
    licenseHistory: { 1: { Fraunces: 'active', 'DM Sans': 'active' }, 2: { Fraunces: 'active', 'DM Sans': 'revoked' } },
    batches: [
      { id: 'b-ok', name: '可补齐', pairIds: [1], status: 'published', licenseRevision: 1, publishedAt: at },
      { id: 'b-bad', name: '补不全', pairIds: [1], status: 'published', licenseRevision: 99, publishedAt: at },
      { id: 'b-draft', name: '旧草稿', pairIds: [1], status: 'draft', licenseRevision: 1 },
    ],
  };
  const { state, notes } = migrate(legacy, createSeedState);
  const pair = state.pairs[0];
  check('pair fonts backfilled', pair.headingFont === 'Fraunces' && pair.bodyFont === 'DM Sans');
  check('pair revision backfilled', pair.revision === 1);
  const bOk = state.batches.find(b => b.id === 'b-ok')!;
  check('snapshot restored from history', bOk.status === 'published' && bOk.snapshot?.licenseRevision === 1);
  check('snapshot uses historic fonts', bOk.snapshot?.fonts['DM Sans'] === 'active');
  const bBad = state.batches.find(b => b.id === 'b-bad')!;
  check('unrecoverable batch parked at pending-review', bBad.status === 'pending-review');
  const bDraft = state.batches.find(b => b.id === 'b-draft')!;
  check('draft recomputed to current revision', bDraft.licenseRevision === 2);
  check('draft blocked fonts recomputed', bDraft.blockedFonts.includes('DM Sans'));
  check('migration notes recorded', notes.length >= 3, notes);

  // 待核批次核准后补齐快照；退回则回到草稿
  const approved = reduce(state, { kind: 'batch.review', opId: opId(), at, batchId: 'b-bad', approve: true }).state;
  const reviewed = approved.batches.find(b => b.id === 'b-bad')!;
  check('approve restores published with snapshot', reviewed.status === 'published' && reviewed.snapshot?.licenseRevision === 2);
  const rejected = reduce(state, { kind: 'batch.review', opId: opId(), at, batchId: 'b-bad', approve: false }).state;
  check('reject returns to draft', rejected.batches.find(b => b.id === 'b-bad')!.status === 'draft');
}

// ---------- 7. 空数据回退种子 ----------
{
  console.log('empty storage falls back to seed');
  const store = new ChainStore(new MemoryKV(), KEYS);
  check('seed pairs loaded', store.getState().pairs.length === 3);
  check('seed batches loaded', store.getState().batches.length === 2);
}

console.log(failures === 0 ? '\nall tests passed' : `\n${failures} test(s) failed`);
if (failures > 0) throw new Error(`${failures} test(s) failed`);
