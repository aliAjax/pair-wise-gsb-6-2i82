import { useState } from 'react';
import { AlertTriangle, Archive, CheckCircle2, Download, FileText, Layers, Plus, RotateCcw, ShieldCheck, ShieldOff } from 'lucide-react';
import { chainActions, useChain } from '../chain/useChain';
import type { Batch, ChainError, ExportRecord } from '../chain/types';

function fmtTime(ts: number): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const BATCH_STATUS: Record<Batch['status'], { label: string; cls: string }> = {
  draft: { label: '草稿', cls: 'grey' },
  published: { label: '已发布', cls: 'green' },
  'pending-review': { label: '待核', cls: 'amber' },
};

export default function ChainView() {
  const store = useChain();
  const state = store.getState();
  const [notice, setNotice] = useState<string | null>(null);
  const [showNewBatch, setShowNewBatch] = useState(false);
  const [batchName, setBatchName] = useState('');
  const [picked, setPicked] = useState<number[]>([]);

  const reportError = (error: ChainError | null) => {
    if (!error) {
      setNotice(null);
      return;
    }
    if (error.type === 'batch-blocked') setNotice(`发布被拒绝：批次包含已撤回授权的字体（${error.fonts.join('、')}）`);
    else if (error.type === 'batch-not-draft') setNotice('待核批次需先核准或退回，不能直接发布');
    else setNotice('操作被拒绝');
  };

  const download = (rec: ExportRecord) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([rec.css], { type: 'text/css' }));
    a.download = `${rec.pairTitle.replace(/\s+/g, '-').toLowerCase()}.css`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const createBatch = () => {
    if (!batchName.trim() || picked.length === 0) return;
    chainActions.createBatch(batchName.trim(), picked);
    setShowNewBatch(false);
    setBatchName('');
    setPicked([]);
  };

  const report = store.lastReport;

  return (
    <div className="chain">
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>字体授权清单</h2>
            <span>清单 v{state.licenses.revision} · 变更后未发布批次自动重算</span>
          </div>
          <ShieldCheck size={17} />
        </div>
        <div className="lic-list">
          {Object.entries(state.licenses.fonts).map(([font, status]) => (
            <div className="lic-row" key={font}>
              <span className="lic-font" style={{ fontFamily: font }}>{font}</span>
              <span className={`pill ${status === 'active' ? 'green' : 'red'}`}>{status === 'active' ? '已授权' : '已撤回'}</span>
              <button
                className="mini"
                onClick={() => {
                  const r = chainActions.setLicense(font, status === 'active' ? 'revoked' : 'active');
                  reportError(r.error);
                }}
              >
                {status === 'active' ? <><ShieldOff size={12} />撤回</> : <><ShieldCheck size={12} />恢复</>}
              </button>
            </div>
          ))}
        </div>
        <p className="panel-note">已发布批次保留发布时的授权快照，不受清单变更影响。</p>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>发布批次</h2>
            <span>{state.batches.length} 个批次 · 引用清单的方案在此流转</span>
          </div>
          <button className="mini primary-mini" onClick={() => { setPicked(state.pairs.map(p => p.id)); setShowNewBatch(true); }}>
            <Plus size={12} />新建批次
          </button>
        </div>
        {notice && <div className="notice"><AlertTriangle size={13} />{notice}</div>}
        <div className="batch-list">
          {state.batches.map(b => {
            const st = BATCH_STATUS[b.status];
            return (
              <div className="batch-card" key={b.id}>
                <div className="batch-top">
                  <b>{b.name}</b>
                  <span className={`pill ${st.cls}`}>{st.label}</span>
                </div>
                <div className="batch-meta">
                  <span>{b.pairIds.length} 个方案</span>
                  <span>基于清单 v{b.licenseRevision}</span>
                  {b.snapshot && <span>快照 v{b.snapshot.licenseRevision} · {fmtTime(b.snapshot.capturedAt)} 已锁定</span>}
                </div>
                {b.blockedFonts.length > 0 && (
                  <div className="batch-blocked"><AlertTriangle size={12} />含已撤回字体：{b.blockedFonts.join('、')}</div>
                )}
                <div className="batch-actions">
                  {b.status === 'draft' && (
                    <button
                      className="mini primary-mini"
                      disabled={b.blockedFonts.length > 0}
                      title={b.blockedFonts.length > 0 ? '含已撤回授权的字体，不能发布' : '按当前授权清单发布'}
                      onClick={() => reportError(chainActions.publishBatch(b.id).error)}
                    >
                      <Archive size={12} />发布批次
                    </button>
                  )}
                  {b.status === 'pending-review' && (
                    <>
                      <button className="mini primary-mini" onClick={() => reportError(chainActions.reviewBatch(b.id, true).error)}>
                        <CheckCircle2 size={12} />核准快照
                      </button>
                      <button className="mini" onClick={() => reportError(chainActions.reviewBatch(b.id, false).error)}>
                        <RotateCcw size={12} />退回草稿
                      </button>
                    </>
                  )}
                  {b.status === 'published' && <span className="batch-lock">已公开 · 以快照为准</span>}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>导出记录</h2>
            <span>{state.exports.length} 条 · 发布时生成，重放不重复</span>
          </div>
          <FileText size={17} />
        </div>
        <div className="exp-list">
          {state.exports.length === 0 && <p className="panel-note">暂无导出记录。</p>}
          {[...state.exports].reverse().map(rec => (
            <div className="exp-row" key={rec.id}>
              <div>
                <b>{rec.pairTitle}</b>
                <span>{state.batches.find(b => b.id === rec.batchId)?.name ?? rec.batchId} · 清单 v{rec.licenseRevision} · {fmtTime(rec.createdAt)}</span>
              </div>
              <button className="mini" onClick={() => download(rec)}><Download size={12} />下载</button>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>恢复与迁移</h2>
            <span>检查点 · 重放 · 旧数据补齐</span>
          </div>
          <Layers size={17} />
        </div>
        {store.degraded && (
          <div className="notice danger"><AlertTriangle size={13} />上次写入失败，当前改动尚未持久化，可从检查点恢复。</div>
        )}
        {report && (report.replayed > 0 || report.skipped > 0 || report.notes.length > 0 || report.source !== 'state') && (
          <div className="report">
            <div className="report-line">
              {report.source === 'checkpoint' ? '主状态损坏，已从最后完整检查点恢复' : report.source === 'seed' ? '已初始化数据' : '已从存储载入'}
              {report.replayed > 0 && ` · 重放 ${report.replayed} 个操作`}
              {report.skipped > 0 && ` · 跳过 ${report.skipped} 个已应用操作（幂等）`}
            </div>
            {report.notes.map((n, i) => <div className="report-note" key={i}>· {n}</div>)}
          </div>
        )}
        <div className="demo-bar">
          <button className="mini" onClick={() => chainActions.injectWriteFailure()}>注入下次写入故障</button>
          <button className="mini" onClick={() => chainActions.recover()}>从检查点恢复</button>
          <button className="mini" onClick={() => chainActions.importLegacyDemo()}>导入旧数据演示迁移</button>
        </div>
        <p className="panel-note">故障注入后，任意操作会写失败；恢复时从最后完整检查点重放待办操作，已应用的自动跳过。</p>
      </section>

      {showNewBatch && (
        <div className="backdrop" onClick={() => setShowNewBatch(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2>新建发布批次</h2>
            <label>批次名称<input autoFocus value={batchName} onChange={e => setBatchName(e.target.value)} placeholder="e.g. 双十一活动页" /></label>
            <div className="pick-list">
              {state.pairs.map(p => (
                <label className="pick" key={p.id}>
                  <input
                    type="checkbox"
                    checked={picked.includes(p.id)}
                    onChange={e => setPicked(e.target.checked ? [...picked, p.id] : picked.filter(id => id !== p.id))}
                  />
                  {p.title}
                </label>
              ))}
            </div>
            <div className="modal-actions">
              <button className="outline" onClick={() => setShowNewBatch(false)}>取消</button>
              <button className="primary" onClick={createBatch}>创建批次</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
