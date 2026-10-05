import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  Copy,
  Database,
  Download,
  FileWarning,
  GitBranch,
  Grid3X3,
  Heart,
  History,
  Link2,
  Lock,
  Plus,
  RefreshCw,
  RotateCcw,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Star,
  Trash2,
  Type,
  Unlock,
  UploadCloud,
  Users,
} from 'lucide-react';
import {
  BatchReadiness,
  BatchStatus,
  ConflictField,
  FONT_OPTIONS,
  Pairing,
  Violation,
  pairingConflicts,
  rebaseDraft,
} from './releaseChain';
import {
  DispatchResult,
  RecoveryReport,
  armNextWriteFailure,
  clearFailureSwitch,
  dispatch as dispatchCommand,
  getState,
  recoverNow,
  resetStore,
  subscribe,
} from './releaseStore';

type Notice = { kind: 'ok' | 'warn' | 'danger'; text: string } | null;

const legacySeed = [
  {
    id: 1,
    title: 'Editorial calm',
    heading: 'A slower way to see',
    body: 'Good typography creates space for ideas to breathe.',
    category: 'Editorial',
    favorite: true,
  },
  {
    id: 2,
    title: 'Studio notes',
    heading: 'Make room for the unexpected',
    body: 'A thoughtful pairing can add rhythm to even the simplest interface.',
    category: 'Portfolio',
    favorite: false,
  },
  {
    id: 3,
    title: 'Field guide',
    heading: 'Small details, lasting impressions',
    body: 'Typography is the voice of a page.',
    category: 'Brand',
    favorite: false,
  },
];

const clonePairing = (pairing: Pairing): Pairing => ({ ...pairing, settings: { ...pairing.settings } });
const samePairing = (a: Pairing, b: Pairing) => JSON.stringify(a) === JSON.stringify(b);

function downloadText(fileName: string, text: string) {
  const href = URL.createObjectURL(new Blob([text], { type: 'text/css' }));
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(href);
}

function statusText(status: BatchStatus, readiness: BatchReadiness) {
  if (status === 'published') return '已公开 · 快照冻结';
  if (readiness === 'pending_verification') return '待核';
  if (readiness === 'blocked') return '授权阻断';
  return status === 'in_review' ? '审核中 · 可发布' : '未发布 · 可发布';
}

function statusClass(status: BatchStatus, readiness: BatchReadiness) {
  if (status === 'published') return 'published';
  if (readiness === 'pending_verification') return 'pending';
  if (readiness === 'blocked') return 'blocked';
  return 'ready';
}

function timeLabel(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

export default function App() {
  const [chain, setChain] = useState(getState);
  const [selectedId, setSelectedId] = useState(() => getState().pairings[0].id);
  const selected = chain.pairings.find((item) => item.id === selectedId) ?? chain.pairings[0];
  const [base, setBase] = useState<Pairing>(() => clonePairing(selected));
  const [baseRevision, setBaseRevision] = useState(() => getState().revision);
  const [draft, setDraft] = useState<Pairing>(() => clonePairing(selected));
  const [staleBase, setStaleBase] = useState<Pairing | null>(null);
  const [conflicts, setConflicts] = useState<ConflictField[]>([]);
  const [notice, setNotice] = useState<Notice>(null);
  const [recovery, setRecovery] = useState<RecoveryReport | null>(null);
  const [newChannel, setNewChannel] = useState('画廊 / 排版画布 / 导出样式');
  const [newFont, setNewFont] = useState('Foundry Display');
  const windowId = useMemo(() => `W-${Math.random().toString(36).slice(2, 6).toUpperCase()}`, []);

  const baseRef = useRef(base);
  const baseRevisionRef = useRef(baseRevision);
  const draftRef = useRef(draft);
  useEffect(() => {
    baseRef.current = base;
    baseRevisionRef.current = baseRevision;
    draftRef.current = draft;
  }, [base, baseRevision, draft]);

  useEffect(() => {
    return subscribe((next) => {
      setChain(next);
      const currentBase = baseRef.current;
      const currentDraft = draftRef.current;
      if (next.revision <= baseRevisionRef.current) return;
      const latest = next.pairings.find((item) => item.id === currentBase.id);
      if (!latest) return;
      const fields = pairingConflicts(currentBase, latest, currentDraft);
      setBase(clonePairing(latest));
      setBaseRevision(next.revision);
      if (!samePairing(currentDraft, currentBase)) {
        setStaleBase(clonePairing(currentBase));
        setConflicts(fields.filter((item) => item.localChanged || item.remoteChanged));
        setNotice({ kind: 'warn', text: `另一个窗口已提交到 r${next.revision}；本地改动已保留，冲突字段列在画布中。` });
      } else {
        setDraft(clonePairing(latest));
        setConflicts([]);
      }
    });
  }, []);

  useEffect(() => {
    const next = getState().pairings.find((item) => item.id === selectedId) ?? getState().pairings[0];
    setBase(clonePairing(next));
    setBaseRevision(getState().revision);
    setDraft(clonePairing(next));
    setConflicts([]);
    setStaleBase(null);
  }, [selectedId]);

  const dirty = !samePairing(draft, base);
  const selectedBatches = chain.batches.filter((batch) => batch.pairingId === selected.id);
  const pendingCount = chain.batches.filter((batch) => batch.readiness === 'pending_verification').length;
  const blockedCount = chain.batches.filter((batch) => batch.readiness === 'blocked' && batch.status !== 'published').length;

  const handleResult = (result: DispatchResult, successText?: string) => {
    setChain(result.state);
    if (result.ok) {
      const latest = result.state.pairings.find((item) => item.id === selected.id);
      if (latest) {
        setBase(clonePairing(latest));
        setBaseRevision(result.state.revision);
        if (result.event.type === 'pairing.update') setDraft(clonePairing(latest));
      }
      setConflicts([]);
      setStaleBase(null);
      setNotice({ kind: 'ok', text: successText ?? `r${result.event.revision} 已提交。` });
      if (result.downloadCss) {
        const record = result.state.exports.find((item) => item.operationId === result.event.id);
        downloadText(record?.fileName ?? 'release.css', result.downloadCss);
      }
      return;
    }

    const latest = result.state.pairings.find((item) => item.id === selected.id);
    if (latest) {
      if (result.reason === 'stale_revision' || result.reason === 'checkpoint_failed') {
        const fields = pairingConflicts(baseRef.current, latest, draftRef.current);
        setBase(clonePairing(latest));
        setBaseRevision(result.state.revision);
        if (!samePairing(draftRef.current, latest)) {
          setStaleBase(clonePairing(baseRef.current));
          setConflicts(fields.filter((item) => item.localChanged || item.remoteChanged));
        }
      } else {
        setBase(clonePairing(latest));
      }
    }
    if (result.recovery) setRecovery(result.recovery);
    setNotice({
      kind: result.reason === 'validation' ? 'warn' : 'danger',
      text: result.message,
    });
  };

  const send = (command: Parameters<typeof dispatchCommand>[0], successText?: string) => {
    handleResult(dispatchCommand(command, baseRevisionRef.current), successText);
  };

  const updateDraft = (patch: Partial<Omit<Pairing, 'settings'>>) => setDraft((current) => ({ ...current, ...patch }));
  const updateSetting = (key: keyof Pairing['settings'], value: number) =>
    setDraft((current) => ({ ...current, settings: { ...current.settings, [key]: value } }));

  const savePairing = () => {
    handleResult(
      dispatchCommand(
        {
          type: 'pairing.update',
          pairingId: selected.id,
          fields: {
            title: draft.title,
            heading: draft.heading,
            body: draft.body,
            category: draft.category,
            favorite: draft.favorite,
            headingFont: draft.headingFont,
            bodyFont: draft.bodyFont,
            settings: draft.settings,
          },
        },
        baseRevision,
      ),
      `方案已提交为 r${getState().revision}，引用它的未发布批次已重算。`,
    );
  };

  const adoptRemote = (path?: string) => {
    if (!path) {
      setDraft(clonePairing(base));
      setConflicts([]);
      return;
    }
    setDraft((current) => {
      const next = clonePairing(current);
      if (path.startsWith('settings.')) {
        const key = path.split('.')[1] as keyof Pairing['settings'];
        next.settings[key] = base.settings[key];
      } else {
        const key = path as keyof Pairing;
        (next as Record<string, unknown>)[key] = base[key as keyof Pairing] as unknown;
      }
      return next;
    });
    setConflicts((items) => items.filter((item) => item.path !== path));
  };

  const mergeNonConflicting = () => {
    const origin = staleBase ?? base;
    const merged = rebaseDraft(origin, base, draft);
    setDraft(clonePairing(merged));
    setConflicts((items) => items.filter((item) => item.conflicting));
    setNotice({ kind: 'ok', text: '无冲突的本地改动已自动改基；真正冲突字段仍保留本地值。' });
  };

  const toggleLicense = (licenseId: string, active: boolean) => {
    send(
      { type: 'license.toggle', licenseId, status: active ? 'active' : 'revoked' },
      active ? '授权已恢复，未发布批次已重算。' : '授权已撤回，未发布批次已重算；公开批次快照不变。',
    );
  };

  const exportBatch = (batchId: string) => {
    handleResult(dispatchCommand({ type: 'export.css', batchId }, baseRevision), '导出记录已幂等写入，并下载当前授权版本的 CSS。');
  };

  const publishBatch = (batchId: string) => {
    handleResult(dispatchCommand({ type: 'batch.publish', batchId }, baseRevision), '批次已公开；配对和双字体授权快照已冻结。');
  };

  const failureDrill = (target: 'journal' | 'checkpoint') => {
    const readyBatch = getState().batches.find((batch) => batch.status !== 'published' && batch.readiness === 'ready');
    if (!readyBatch) {
      setNotice({ kind: 'warn', text: '当前没有可导出的未发布批次，无法执行故障演练。' });
      return;
    }
    armNextWriteFailure(target);
    handleResult(dispatchCommand({ type: 'export.css', batchId: readyBatch.id }, baseRevision));
  };

  const loadLegacyAndReload = () => {
    localStorage.setItem('type-pairs', JSON.stringify(legacySeed));
    localStorage.removeItem('type-release-chain-v1');
    localStorage.removeItem('type-release-journal-v1');
    localStorage.removeItem('type-release-checkpoint-complete-v1');
    clearFailureSwitch();
    window.location.reload();
  };

  return (
    <div className="app">
      <aside>
        <div className="brand">
          <div className="brand-mark"><Type size={18} /></div>
          <div><b>Type Release</b><small>FONT PUBLICATION CHAIN</small></div>
        </div>
        <div className="nav-section">
          <span>发布链</span>
          <button className="nav active"><GitBranch size={16} />方案与批次 <b>{chain.batches.length}</b></button>
          <button className="nav"><ShieldCheck size={16} />有效授权 <b>{chain.licenses.filter((item) => item.status === 'active').length}</b></button>
          <button className="nav"><FileWarning size={16} />待核 / 阻断 <b>{pendingCount + blockedCount}</b></button>
        </div>
        <div className="saved">
          <div className="saved-head"><span>当前窗口</span><Users size={14} /></div>
          <div className="window-card">
            <b>{windowId}</b>
            <small>持有修订号 r{baseRevision}</small>
            <span>{dirty ? '有未提交本地改动' : '与发布链同步'}</span>
          </div>
          <button className="collection" onClick={() => window.open(window.location.href, '_blank')}><i style={{ background: '#9fc9be' }} />再打开一个窗口<b>↗</b></button>
        </div>
        <div className="aside-foot">
          <button className="nav" onClick={recoverNow}><Database size={16} />从检查点恢复</button>
          <button className="nav" onClick={() => resetStore()}><RotateCcw size={16} />重置演示数据</button>
          <div className="profile">
            <div className="avatar">YL</div>
            <div><b>Yuki Lin</b><small>设计发布工作台</small></div>
            <Settings2 size={14} />
          </div>
        </div>
      </aside>

      <main>
        <header>
          <div>
            <div className="crumb">FONT LICENSE / PAIRING / BATCH / EXPORT</div>
            <h1>一条可重算、可冻结的字体发布链</h1>
            <p>授权清单变化只重算未发布批次；已经公开的批次永久读取发布时快照。</p>
          </div>
          <div className="actions">
            <button className="outline" onClick={() => send({ type: 'batch.create', pairingId: selected.id, channel: newChannel }, '新批次已接入发布链并完成首次校验。')}>
              <Plus size={15} />创建发布批次
            </button>
            <button className="primary" onClick={savePairing} disabled={!dirty}><UploadCloud size={15} />提交 r{baseRevision + 1}</button>
          </div>
        </header>

        {notice && <div className={`notice ${notice.kind}`}><AlertTriangle size={15} />{notice.text}</div>}
        {chain.migration && <MigrationBanner report={chain.migration} />}
        {recovery && <RecoveryBanner report={recovery} onRecover={() => setRecovery(recoverNow())} />}

        <div className="chain-summary">
          <div><span>全局修订号</span><b>r{chain.revision}</b><small>乐观锁 / CAS</small></div>
          <div><span>待核批次</span><b>{pendingCount}</b><small>授权快照补不全</small></div>
          <div><span>阻断批次</span><b>{blockedCount}</b><small>引用撤回字体</small></div>
          <div><span>导出记录</span><b>{chain.exports.length}</b><small>按操作 ID 幂等</small></div>
        </div>
        <div className="channel-editor">
          <label>新批次渠道<input value={newChannel} onChange={(event) => setNewChannel(event.target.value)} /></label>
          <small>同一方案进入画廊、排版画布与导出样式时共用该批次快照。</small>
        </div>

        {conflicts.length > 0 && <ConflictPanel conflicts={conflicts} onAdopt={adoptRemote} onMerge={mergeNonConflicting} onForce={savePairing} />}

        <div className="layout">
          <section className="gallery">
            <div className="gallery-head">
              <div><h2>配对方案</h2><span>{chain.pairings.length} 个方案 · 改动带修订号</span></div>
              <div className="view-toggle"><button className="on"><Grid3X3 size={14} /></button><button><BookOpen size={14} /></button></div>
            </div>
            <div className="pair-list">
              {chain.pairings.map((pairing) => {
                const batches = chain.batches.filter((batch) => batch.pairingId === pairing.id);
                const linkedProblem = batches.some((batch) => batch.status !== 'published' && batch.readiness !== 'ready');
                return (
                  <button key={pairing.id} className={selected.id === pairing.id ? 'pair selected' : 'pair'} onClick={() => setSelectedId(pairing.id)}>
                    <div className="pair-top"><span>{pairing.category} · r{pairing.revision}</span><Heart size={15} fill={pairing.favorite ? '#e88769' : 'none'} color={pairing.favorite ? '#e88769' : '#aeb5b7'} /></div>
                    <strong style={{ fontFamily: pairing.headingFont }}>{pairing.heading}</strong>
                    <p style={{ fontFamily: pairing.bodyFont }}>{pairing.body}</p>
                    <div className="pair-foot">
                      <span>{pairing.title}</span>
                      <small className={linkedProblem ? 'danger-text' : ''}>{batches.length} 批次{linkedProblem ? ' · 需处理' : ''}</small>
                    </div>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="studio">
            <div className="studio-head">
              <div><span>排版画布 · BASE r{baseRevision}{dirty && ' · 本地已改'}</span><h2>{draft.title}</h2></div>
              <button className="favorite" onClick={() => updateDraft({ favorite: !draft.favorite })}><Star size={16} fill={draft.favorite ? '#e5a35e' : 'none'} color={draft.favorite ? '#e5a35e' : '#98a4a7'} /></button>
            </div>
            <div className="canvas">
              <div className="canvas-bar"><span>PREVIEW</span><div><button>画廊</button><button>画布</button><button>导出</button></div></div>
              <div className="preview">
                <span className="preview-kicker">{draft.category.toUpperCase()} · {draft.headingFont} + {draft.bodyFont}</span>
                <h3 contentEditable suppressContentEditableWarning onBlur={(event) => updateDraft({ heading: event.currentTarget.textContent ?? '' })} style={{ fontFamily: draft.headingFont, fontSize: `${draft.settings.size}px`, fontWeight: draft.settings.weight, letterSpacing: `${draft.settings.tracking}px`, lineHeight: 1.05 }}>{draft.heading}</h3>
                <p contentEditable suppressContentEditableWarning onBlur={(event) => updateDraft({ body: event.currentTarget.textContent ?? '' })} style={{ fontFamily: draft.bodyFont, lineHeight: draft.settings.leading, letterSpacing: `${draft.settings.tracking / 2}px` }}>{draft.body}</p>
                <div className="preview-rule" />
                <span className="preview-meta">PAIRING {selected.id.toUpperCase()} · REVISION {baseRevision}</span>
              </div>
            </div>
            <div className="controls">
              <div className="control-head"><div><span>TYPE CONTROLS</span><h3>保存落后窗口的本地改动</h3></div><SlidersHorizontal size={17} /></div>
              <div className="font-row">
                <label>标题字体<select value={draft.headingFont} onChange={(event) => updateDraft({ headingFont: event.target.value })}>{FONT_OPTIONS.map((font) => <option key={font}>{font}</option>)}<option>Foundry Display</option></select></label>
                <label>正文字体<select value={draft.bodyFont} onChange={(event) => updateDraft({ bodyFont: event.target.value })}>{FONT_OPTIONS.map((font) => <option key={font}>{font}</option>)}<option>Foundry Display</option></select></label>
              </div>
              <div className="range-row">
                <label>Size <b>{draft.settings.size}px</b><input type="range" min="28" max="76" value={draft.settings.size} onChange={(event) => updateSetting('size', Number(event.target.value))} /></label>
                <label>Weight <b>{draft.settings.weight}</b><input type="range" min="300" max="800" step="100" value={draft.settings.weight} onChange={(event) => updateSetting('weight', Number(event.target.value))} /></label>
              </div>
              <div className="range-row">
                <label>Line height <b>{draft.settings.leading.toFixed(2)}</b><input type="range" min="1" max="1.8" step=".05" value={draft.settings.leading} onChange={(event) => updateSetting('leading', Number(event.target.value))} /></label>
                <label>Letter spacing <b>{draft.settings.tracking}px</b><input type="range" min="-1" max="3" step=".5" value={draft.settings.tracking} onChange={(event) => updateSetting('tracking', Number(event.target.value))} /></label>
              </div>
            </div>
            <div className="studio-foot">
              <button className="delete" onClick={() => { setDraft(clonePairing(base)); setConflicts([]); }} disabled={!dirty}><Trash2 size={15} />放弃本地改动</button>
              <button className="save" onClick={savePairing} disabled={!dirty}><CheckIcon />带 r{baseRevision + 1} 提交</button>
            </div>
          </section>
        </div>

        <section className="release-grid">
          <LicensePanel licenses={chain.licenses} newFont={newFont} onNewFont={setNewFont} onToggle={toggleLicense} onCreate={() => send({ type: 'license.create', fontName: newFont }, '授权已补齐，待核批次已重新计算。')} />
          <BatchPanel batches={selectedBatches} onPublish={publishBatch} onExport={exportBatch} />
          <ExportAudit chain={chain} onRecover={() => setRecovery(recoverNow())} onDrill={failureDrill} onLegacy={loadLegacyAndReload} />
        </section>
      </main>
    </div>
  );
}

function MigrationBanner({ report }: { report: NonNullable<ReturnType<typeof getState>['migration']> }) {
  return (
    <div className={`notice ${report.status === 'completed' ? 'ok' : 'warn'}`}>
      <Database size={15} />旧数据迁移：{report.note} 可发布 {report.ready} / 待核 {report.pending} / 阻断 {report.blocked}。
    </div>
  );
}

function RecoveryBanner({ report, onRecover }: { report: RecoveryReport; onRecover: () => void }) {
  return (
    <div className="notice danger">
      <RefreshCw size={15} />
      已恢复到 r{report.restoredRevision}：重放 {report.replayedEvents} 条日志，识别重复操作 {report.duplicatedOperations} 次，新增导出 {report.recoveredExports} 条、发布记录 {report.recoveredPublishRecords} 条（均未重复）。
      <button onClick={onRecover}>再次校验检查点</button>
    </div>
  );
}

function ConflictPanel({ conflicts, onAdopt, onMerge, onForce }: { conflicts: ConflictField[]; onAdopt: (path?: string) => void; onMerge: () => void; onForce: () => void }) {
  const changed = conflicts.filter((item) => item.localChanged || item.remoteChanged);
  const hard = changed.filter((item) => item.conflicting);
  return (
    <div className="conflict-panel">
      <div className="conflict-head"><b><AlertTriangle size={16} />乐观锁拒绝落后提交</b><span>{hard.length} 个同字段冲突；本地改动没有被覆盖。</span></div>
      <div className="conflict-actions"><button onClick={onMerge}>自动合并非冲突改动</button><button onClick={() => onAdopt()}>全部采用最新</button><button className="force" onClick={onForce}>保留本地并按最新号重提</button></div>
      <div className="conflict-fields">
        {changed.map((field) => (
          <div key={field.path} className={field.conflicting ? 'conflict-row hard' : 'conflict-row'}>
            <b>{field.label}</b>
            <span>本地：{field.localValue || '空'}</span>
            <span>最新：{field.remoteValue || '空'}</span>
            {field.conflicting && <small>同字段冲突</small>}
            {!field.conflicting && field.localChanged && <small>可自动改基</small>}
            {!field.conflicting && field.remoteChanged && <small>仅远端变化</small>}
            <button onClick={() => onAdopt(field.path)}>采用最新</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function LicensePanel({ licenses, newFont, onNewFont, onToggle, onCreate }: {
  licenses: ReturnType<typeof getState>['licenses'];
  newFont: string;
  onNewFont: (value: string) => void;
  onToggle: (id: string, active: boolean) => void;
  onCreate: () => void;
}) {
  return (
    <div className="chain-card license-card">
      <div className="card-head"><span><Link2 size={15} />字体授权清单</span><b>{licenses.filter((item) => item.status === 'active').length}/{licenses.length}</b></div>
      <div className="license-list">
        {licenses.map((license) => (
          <div key={license.id} className={`license-row ${license.status}`}>
            <div>{license.status === 'active' ? <Unlock size={14} /> : <Lock size={14} />}<b>{license.fontName}</b><small>{license.vendor}</small></div>
            <button onClick={() => onToggle(license.id, license.status === 'revoked')}>{license.status === 'active' ? '撤回' : '恢复'}</button>
          </div>
        ))}
      </div>
      <div className="inline-form">
        <input value={newFont} onChange={(event) => onNewFont(event.target.value)} />
        <button onClick={onCreate}><Plus size={14} />补授权并重算</button>
      </div>
    </div>
  );
}

function BatchPanel({ batches, onPublish, onExport }: { batches: ReturnType<typeof getState>['batches']; onPublish: (id: string) => void; onExport: (id: string) => void }) {
  return (
    <div className="chain-card">
      <div className="card-head"><span><GitBranch size={15} />发布批次</span><b>{batches.length}</b></div>
      <div className="batch-list">
        {batches.length === 0 && <p className="empty">这个方案还没有批次。创建后会立即校验画廊、画布和导出共用的字体授权。</p>}
        {batches.map((batch) => (
          <article key={batch.id} className={`batch-row ${statusClass(batch.status, batch.readiness)}`}>
            <header><b>{batch.id}</b><span className={`pill ${statusClass(batch.status, batch.readiness)}`}>{statusText(batch.status, batch.readiness)}</span></header>
            <small>{batch.channel} · 计算于 r{batch.computedRevision} · {timeLabel(batch.updatedAt)}</small>
            {batch.violations.length > 0 && <ViolationList violations={batch.violations} />}
            {batch.snapshot && (
              <div className="snapshot">
                <ShieldCheck size={14} /><span>公开快照 r{batch.snapshot.revision} · {batch.snapshot.hash}</span>
                <small>{batch.snapshot.pairing.headingFont} / {batch.snapshot.pairing.bodyFont} 授权状态已冻结</small>
              </div>
            )}
            <div className="row-actions">
              <button disabled={batch.readiness !== 'ready' || batch.status === 'published'} onClick={() => onPublish(batch.id)}>
                {batch.status === 'published' ? <CheckCircle2 size={13} /> : <UploadCloud size={13} />}发布
              </button>
              <button disabled={batch.status !== 'published' && batch.readiness !== 'ready'} onClick={() => onExport(batch.id)}><Download size={13} />导出 CSS</button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function ViolationList({ violations }: { violations: Violation[] }) {
  return <ul className="violations">{violations.map((violation) => <li key={`${violation.slot}-${violation.fontName}-${violation.code}`}>{violation.message}</li>)}</ul>;
}

function ExportAudit({ chain, onRecover, onDrill, onLegacy }: { chain: ReturnType<typeof getState>; onRecover: () => void; onDrill: (target: 'journal' | 'checkpoint') => void; onLegacy: () => void }) {
  return (
    <div className="chain-card">
      <div className="card-head"><span><History size={15} />导出与检查点</span><b>{chain.exports.length}</b></div>
      <div className="ops-grid">
        <button onClick={() => onDrill('checkpoint')}><RefreshCw size={14} />模拟检查点写入失败</button>
        <button onClick={() => onDrill('journal')}><RefreshCw size={14} />模拟日志写入失败</button>
        <button onClick={onRecover}><Database size={14} />检查并恢复</button>
        <button onClick={onLegacy}><FileWarning size={14} />载入旧版数据</button>
      </div>
      <div className="export-list">
        {chain.exports.map((record) => (
          <div key={record.id} className="export-row">
            <Copy size={13} />
            <div><b>{record.id}</b><small>{record.fileName}</small><span>{record.fromSnapshot ? '公开快照导出' : '未发布当前授权导出'} · {timeLabel(record.createdAt)}</span></div>
          </div>
        ))}
      </div>
      <div className="activity">
        {chain.activity.slice(0, 6).map((item) => <div key={item.id}><span>r{item.revision}</span><p>{item.message}</p><small>{timeLabel(item.at)}</small></div>)}
      </div>
    </div>
  );
}

function CheckIcon() {
  return <span className="check">✓</span>;
}
