import {
  Command,
  ReleaseEvent,
  ReleaseState,
  createEventId,
  createSeedState,
  migrateLegacyPairs,
  replayEvents,
  reduceWithInfo,
  batchCss,
  evaluateBatch,
} from './releaseChain';

const STATE_KEY = 'type-release-chain-v1';
const JOURNAL_KEY = 'type-release-journal-v1';
const LEGACY_KEY = 'type-pairs';
export const COMPLETE_MARKER_KEY = 'type-release-checkpoint-complete-v1';
const FAIL_KEY = 'type-release-fail-next-v1';
const EVENT_SUBSCRIBERS = new Set<(state: ReleaseState) => void>();

export type DispatchFailure = 'checkpoint' | 'journal' | 'none';

export type DispatchResult =
  | { ok: true; state: ReleaseState; event: ReleaseEvent; downloadCss?: string; duplicate?: boolean }
  | {
      ok: false;
      reason: 'stale_revision' | 'validation' | 'journal_failed' | 'checkpoint_failed';
      state: ReleaseState;
      expectedRevision: number;
      message: string;
      downloadCss?: string;
      recovery?: RecoveryReport;
    };

export type RecoveryReport = {
  restoredRevision: number;
  replayedEvents: number;
  duplicatedOperations: number;
  recoveredExports: number;
  recoveredPublishRecords: number;
  truncatedJournal: number;
  at: string;
};

type PersistBundle = {
  checkpoint?: string;
  journal: string;
  marker: boolean;
};

let state: ReleaseState;
let memoryJournal: ReleaseEvent[] = [];

function writeRaw(key: string, value: string): void {
  localStorage.setItem(key, value);
}

function removeRaw(keys: string[]): void {
  keys.forEach((key) => localStorage.removeItem(key));
}

function persistJournal(events: ReleaseEvent[]): string {
  return JSON.stringify({ events });
}

function failRequested(target: 'journal' | 'checkpoint'): boolean {
  return localStorage.getItem(FAIL_KEY) === target;
}

function simulateJournalWrite(events: ReleaseEvent[]): PersistBundle {
  if (failRequested('journal')) {
    localStorage.removeItem(FAIL_KEY);
    throw new DOMException('模拟写入失败：事务日志未完成落盘。', 'QuotaExceededError');
  }
  return { journal: persistJournal(events), marker: false };
}

function simulateCheckpointWrite(candidate: ReleaseState, events: ReleaseEvent[]): PersistBundle {
  if (failRequested('checkpoint')) {
    localStorage.removeItem(FAIL_KEY);
    throw new DOMException('模拟写入失败：完整检查点未完成落盘。', 'QuotaExceededError');
  }
  return { checkpoint: JSON.stringify(candidate), journal: persistJournal([]), marker: true };
}

function countRecords(reference: ReleaseState) {
  return {
    exports: reference.exports.length,
    publishes: reference.batches.filter((batch) => batch.status === 'published').length,
  };
}

function restoreFromLastCompleteCheckpoint(): { state: ReleaseState; report: RecoveryReport; journal: ReleaseEvent[] } {
  const checkpointRaw = localStorage.getItem(STATE_KEY);
  const marker = localStorage.getItem(COMPLETE_MARKER_KEY) === '1';
  const journalRaw = localStorage.getItem(JOURNAL_KEY);

  if (!checkpointRaw || !marker) {
    const fresh = createSeedState();
    return {
      state: fresh,
      journal: [],
      report: {
        restoredRevision: fresh.revision,
        replayedEvents: 0,
        duplicatedOperations: 0,
        recoveredExports: fresh.exports.length,
        recoveredPublishRecords: fresh.batches.filter((batch) => batch.status === 'published').length,
        truncatedJournal: 0,
        at: new Date().toISOString(),
      },
    };
  }

  const checkpoint = JSON.parse(checkpointRaw) as ReleaseState;
  const journal = journalRaw ? (JSON.parse(journalRaw) as { events: ReleaseEvent[] }).events : [];
  const before = countRecords(checkpoint);
  const result = replayEvents(checkpoint, journal);
  const after = countRecords(result.state);

  removeRaw([STATE_KEY, JOURNAL_KEY, COMPLETE_MARKER_KEY]);
  // Replay once, then turn the recovered projection into a fresh complete
  // checkpoint. A second recovery therefore sees the operation id and cannot
  // regenerate the same publication/export record.
  writeRaw(STATE_KEY, JSON.stringify(result.state));
  writeRaw(JOURNAL_KEY, persistJournal([]));
  localStorage.setItem(COMPLETE_MARKER_KEY, '1');

  const report: RecoveryReport = {
    restoredRevision: result.state.revision,
    replayedEvents: journal.length,
    duplicatedOperations: result.duplicates,
    recoveredExports: after.exports - before.exports,
    recoveredPublishRecords: after.publishes - before.publishes,
    truncatedJournal: 0,
    at: new Date().toISOString(),
  };
  return { state: result.state, report, journal: [] };
}

function emit(next: ReleaseState): void {
  state = next;
  EVENT_SUBSCRIBERS.forEach((listener) => listener(next));
}

export function getState(): ReleaseState {
  return state;
}

export function subscribe(listener: (next: ReleaseState) => void): () => void {
  EVENT_SUBSCRIBERS.add(listener);
  return () => EVENT_SUBSCRIBERS.delete(listener);
}

function validateCommand(command: Command, current: ReleaseState, baseRevision: number): string | undefined {
  if (baseRevision !== current.revision) {
    return `当前窗口基于 r${baseRevision}，最新发布链已经到 r${current.revision}。`;
  }
  if (command.type === 'pairing.update') {
    if (!current.pairings.some((item) => item.id === command.pairingId)) return '配对方案不存在。';
  }
  if (command.type === 'license.toggle') {
    if (!current.licenses.some((item) => item.id === command.licenseId)) return '授权记录不存在。';
  }
  if (command.type === 'license.create') {
    const fontName = command.fontName.trim();
    if (!fontName) return '请输入字体名称。';
    if (current.licenses.some((item) => item.fontName.toLowerCase() === fontName.toLowerCase())) return '该字体授权已存在。';
  }
  if (command.type === 'batch.create') {
    if (!current.pairings.some((item) => item.id === command.pairingId)) return '无法为不存在的方案创建批次。';
    if (!command.channel.trim()) return '请填写发布渠道。';
  }
  if (command.type === 'batch.publish' || command.type === 'export.css') {
    const batch = current.batches.find((item) => item.id === command.batchId);
    if (!batch) return '发布批次不存在。';
    const pairing = current.pairings.find((item) => item.id === batch.pairingId);
    if (pairing && batch.status !== 'published') {
      const checked = evaluateBatch(batch, pairing, current.licenses, current.revision, new Date().toISOString());
      if (command.type === 'batch.publish' && checked.readiness !== 'ready') {
        return checked.violations[0]?.message ?? '批次未通过发布校验。';
      }
      if (command.type === 'export.css' && checked.readiness !== 'ready') {
        return '未发布批次存在授权问题，不能继续导出旧稿。';
      }
    }
    if (command.type === 'batch.publish' && batch.status === 'published') return '该批次已经公开，发布记录不会重复生成。';
  }
  return undefined;
}

function eventFor(command: Command, current: ReleaseState): ReleaseEvent {
  return { ...command, id: createEventId(), at: new Date().toISOString(), revision: current.revision + 1 };
}

export function dispatch(command: Command, baseRevision: number): DispatchResult {
  const current = getState();
  const staleMessage = validateCommand(command, current, baseRevision);
  if (baseRevision !== current.revision) {
    return {
      ok: false,
      reason: 'stale_revision',
      state: current,
      expectedRevision: current.revision,
      message: staleMessage ?? '修订号落后，请先合并最新发布链。',
    };
  }
  if (staleMessage) {
    return { ok: false, reason: 'validation', state: current, expectedRevision: current.revision, message: staleMessage };
  }

  const event = eventFor(command, current);
  let candidate: ReleaseState;
  try {
    const result = reduceWithInfo(current, event);
    candidate = result.state;
  } catch (error) {
    return {
      ok: false,
      reason: 'validation',
      state: current,
      expectedRevision: current.revision,
      message: error instanceof Error ? error.message : '发布校验失败。',
    };
  }

  const downloadCss = command.type === 'export.css' ? batchCss(candidate, command.batchId) : undefined;

  const beforeCounts = countRecords(current);
  const afterCounts = countRecords(candidate);
  if (afterCounts.exports < beforeCounts.exports || afterCounts.publishes < beforeCounts.publishes) {
    return {
      ok: false,
      reason: 'validation',
      state: current,
      expectedRevision: current.revision,
      message: '操作会移除既有发布记录，已拒绝。',
    };
  }

  let bundle: PersistBundle;
  try {
    bundle = simulateJournalWrite([...memoryJournal, event]);
  } catch {
    // Keep the previous complete journal visible; the candidate event and its
    // publication records remain only in memory and are not exposed as durable.
    writeRaw(JOURNAL_KEY, persistJournal(memoryJournal));
    return {
      ok: false,
      reason: 'journal_failed',
      state: current,
      expectedRevision: current.revision,
      message: '事务日志写入失败，已回滚到最后一个完整检查点。请执行“检查并恢复”。',
    };
  }

  // Keep the previous journal as an undo target while the new event is staged.
  writeRaw(JOURNAL_KEY, persistJournal(memoryJournal));
  writeRaw(JOURNAL_KEY, bundle.journal);

  try {
    bundle = simulateCheckpointWrite(candidate, memoryJournal);
  } catch {
    // The old durable checkpoint and marker are intentionally left in place.
    const recovery = restoreFromLastCompleteCheckpoint();
    emit(recovery.state);
    memoryJournal = recovery.journal;
    return {
      ok: false,
      reason: 'checkpoint_failed',
      state: recovery.state,
      expectedRevision: recovery.state.revision,
      message: '检查点写入失败；已从最后一个完整检查点恢复并重放日志，发布记录幂等未重复。',
      recovery: recovery.report,
    };
  }

  writeRaw(STATE_KEY, bundle.checkpoint!);
  writeRaw(JOURNAL_KEY, bundle.journal);
  if (bundle.marker) localStorage.setItem(COMPLETE_MARKER_KEY, '1'); else localStorage.removeItem(COMPLETE_MARKER_KEY);

  memoryJournal = [];
  emit(candidate);
  return { ok: true, state: candidate, event, downloadCss };
}

export function recoverNow(): RecoveryReport {
  const recovery = restoreFromLastCompleteCheckpoint();
  memoryJournal = recovery.journal;
  emit(recovery.state);
  return recovery.report;
}

export function armNextWriteFailure(target: 'journal' | 'checkpoint' = 'checkpoint'): void {
  localStorage.setItem(FAIL_KEY, target);
}

export function clearFailureSwitch(): void {
  localStorage.removeItem(FAIL_KEY);
}

export function resetStore(preserveLegacy = false): ReleaseState {
  const seed = createSeedState();
  writeRaw(STATE_KEY, JSON.stringify(seed));
  writeRaw(JOURNAL_KEY, persistJournal([]));
  localStorage.setItem(COMPLETE_MARKER_KEY, '1');
  localStorage.removeItem(FAIL_KEY);
  if (!preserveLegacy) localStorage.removeItem(LEGACY_KEY);
  memoryJournal = [];
  emit(seed);
  return seed;
}

function boot(): ReleaseState {
  let bootState = createSeedState();
  try {
    const checkpointRaw = localStorage.getItem(STATE_KEY);
    const marker = localStorage.getItem(COMPLETE_MARKER_KEY) === '1';
    const journalRaw = localStorage.getItem(JOURNAL_KEY);
    const legacyRaw = localStorage.getItem(LEGACY_KEY);

    if (checkpointRaw) {
      const checkpoint = JSON.parse(checkpointRaw) as ReleaseState;
      if (!marker) throw new Error('checkpoint incomplete');
      const journal = journalRaw ? (JSON.parse(journalRaw) as { events: ReleaseEvent[] }).events : [];
      const replayed = replayEvents(checkpoint, journal);
      bootState = replayed.state;
      memoryJournal = journal;
    } else if (legacyRaw) {
      bootState = migrateLegacyPairs(legacyRaw);
      writeRaw(STATE_KEY, JSON.stringify(bootState));
      writeRaw(JOURNAL_KEY, persistJournal([]));
      localStorage.setItem(COMPLETE_MARKER_KEY, '1');
      memoryJournal = [];
    } else {
      writeRaw(STATE_KEY, JSON.stringify(bootState));
      writeRaw(JOURNAL_KEY, persistJournal([]));
      localStorage.setItem(COMPLETE_MARKER_KEY, '1');
    }
  } catch {
    const recovery = restoreFromLastCompleteCheckpoint();
    bootState = recovery.state;
    memoryJournal = recovery.journal;
  }

  window.addEventListener('storage', (event) => {
    if (![STATE_KEY, JOURNAL_KEY, COMPLETE_MARKER_KEY].includes(event.key ?? '')) return;
    const currentRaw = localStorage.getItem(STATE_KEY);
    if (currentRaw && localStorage.getItem(COMPLETE_MARKER_KEY) === '1') {
      const checkpoint = JSON.parse(currentRaw) as ReleaseState;
      const journalRaw = localStorage.getItem(JOURNAL_KEY);
      const journal = journalRaw ? (JSON.parse(journalRaw) as { events: ReleaseEvent[] }).events : [];
      const result = replayEvents(checkpoint, journal);
      memoryJournal = journal;
      emit(result.state);
    }
  });

  state = bootState;
  return bootState;
}

boot();
