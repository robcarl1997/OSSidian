import { useState, useEffect, useCallback } from 'react';
import type { GitStatus, GitCommit, GitFileStatus } from '../../../shared/ipc';

interface GitPanelProps {
  vaultPath: string | null;
  onFileOpen: (path: string) => void;
  onCommit?: () => void;
  onRestoreComplete?: (vaultRelPaths: string[]) => void;
}

// ─── File status helpers ──────────────────────────────────────────────────────

function statusLabel(index: string, workingDir: string): string {
  if (index === '?' && workingDir === '?') return 'U';
  if (index !== ' ' && index !== '?') return index;     // staged
  return workingDir;                                     // unstaged
}

function statusTitle(index: string, workingDir: string): string {
  const code = statusLabel(index, workingDir);
  switch (code) {
    case 'M': return 'Geändert';
    case 'A': return 'Hinzugefügt';
    case 'D': return 'Gelöscht';
    case 'R': return 'Umbenannt';
    case 'U': return 'Nicht verfolgt';
    default:  return code;
  }
}

function isStaged(f: GitFileStatus): boolean {
  return f.index !== ' ' && f.index !== '?' && f.index !== '';
}

function isUnstaged(f: GitFileStatus): boolean {
  return f.workingDir !== ' ' && f.workingDir !== '';
}

// ─── FileRow ─────────────────────────────────────────────────────────────────

function FileRow({
  file,
  staged,
  vaultPath,
  onAction,
  onOpen,
  onRestore,
}: {
  file: GitFileStatus;
  staged: boolean;
  vaultPath: string;
  onAction: (path: string, staged: boolean) => void;
  onOpen: (path: string) => void;
  onRestore?: (path: string) => void;
}) {
  const label = staged ? statusLabel(file.index, ' ') : statusLabel(' ', file.workingDir === '?' ? '?' : file.workingDir);
  const title = statusTitle(file.index, file.workingDir);
  const name  = file.path.split('/').pop() ?? file.path;
  const fullPath = `${vaultPath}/${file.path}`;

  return (
    <div className="git-file-row" title={file.path}>
      <span className={`git-status-badge git-status-${label.toLowerCase()}`}>{label}</span>
      <span
        className="git-file-name"
        title={title}
        onClick={() => file.path.endsWith('.md') && onOpen(fullPath)}
      >
        {name}
      </span>
      {onRestore && (
        <button
          className="git-action-btn git-action-restore"
          title="Änderungen zurücksetzen"
          onClick={() => onRestore(file.path)}
        >
          ↺
        </button>
      )}
      <button
        className="git-action-btn"
        title={staged ? 'Unstagen' : 'Stagen'}
        onClick={() => onAction(file.path, staged)}
      >
        {staged ? '−' : '+'}
      </button>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function GitPanel({ vaultPath, onFileOpen, onCommit, onRestoreComplete }: GitPanelProps) {
  const [status,        setStatus]        = useState<GitStatus | null>(null);
  const [commits,       setCommits]       = useState<GitCommit[]>([]);
  const [commitMsg,     setCommitMsg]     = useState('');
  const [loading,        setLoading]        = useState(false);
  const [showLog,        setShowLog]        = useState(false);
  const [error,          setError]          = useState<string | null>(null);
  const [confirmRestore, setConfirmRestore] = useState<'all' | string | null>(null);

  const refresh = useCallback(async () => {
    if (!vaultPath) return;
    try {
      const s = await window.vaultApp.gitStatus();
      setStatus(s);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [vaultPath]);

  // Initial load + refresh when vault changes
  useEffect(() => {
    refresh();
    const unsub = window.vaultApp.onVaultChanged(() => refresh());
    return unsub;
  }, [refresh]);

  const loadLog = useCallback(async () => {
    const log = await window.vaultApp.gitLog(30);
    setCommits(log);
  }, []);

  useEffect(() => {
    if (showLog) loadLog();
  }, [showLog, loadLog]);

  const withLoading = async (fn: () => Promise<void>) => {
    setLoading(true);
    setError(null);
    try { await fn(); } catch (e) { setError(String(e)); }
    setLoading(false);
    await refresh();
    if (showLog) loadLog();
  };

  if (!vaultPath) {
    return <div className="git-empty">Kein Vault geöffnet</div>;
  }

  if (!status) {
    return <div className="git-empty">Lade…</div>;
  }

  if (!status.isRepo) {
    return (
      <div className="git-init-screen">
        <div className="git-empty-icon">⎇</div>
        <div className="git-empty-text">Kein Git-Repository</div>
        <button
          className="btn btn-primary"
          disabled={loading}
          onClick={() => withLoading(() => window.vaultApp.gitInit())}
        >
          Git initialisieren
        </button>
        {error && <div className="git-error">{error}</div>}
      </div>
    );
  }

  const staged   = status.files.filter(f => isStaged(f));
  const unstaged = status.files.filter(f => !isStaged(f) && isUnstaged(f) && f.index !== '?');
  const untracked = status.files.filter(f => f.index === '?' && f.workingDir === '?');
  const hasStaged = staged.length > 0;

  const stageAll    = () => withLoading(() => window.vaultApp.gitAdd(['.']));
  const stageFile   = (p: string) => withLoading(() => window.vaultApp.gitAdd([p]));
  const unstageFile = (p: string) => withLoading(() => window.vaultApp.gitUnstage([p]));

  const restoreFile = (p: string) => {
    setConfirmRestore(p);
  };
  const restoreAll = () => {
    setConfirmRestore('all');
  };
  const executeRestore = (target: 'all' | string) => {
    setConfirmRestore(null);
    const allUnstaged = [...unstaged, ...untracked].map(f => f.path);
    const paths = target === 'all' ? allUnstaged : [target];
    withLoading(async () => {
      await window.vaultApp.gitRestore(paths);
      onRestoreComplete?.(paths);
    });
  };
  const doCommit   = () => {
    if (!commitMsg.trim()) return;
    withLoading(async () => {
      await window.vaultApp.gitCommit(commitMsg.trim());
      setCommitMsg('');
      onCommit?.();
    });
  };

  return (
    <div className="git-panel">
      {/* Branch header */}
      <div className="git-branch-bar">
        <span className="git-branch-icon">⎇</span>
        <span className="git-branch-name">{status.branch || 'main'}</span>
        {status.ahead  > 0 && <span className="git-ahead">↑{status.ahead}</span>}
        {status.behind > 0 && <span className="git-behind">↓{status.behind}</span>}
        <button className="git-refresh-btn" title="Aktualisieren" onClick={refresh}>↻</button>
      </div>

      {error && <div className="git-error">{error}</div>}

      {/* Staged changes */}
      <div className="git-section">
        <div className="git-section-header">
          <span>Staged ({staged.length})</span>
          {staged.length > 0 && (
            <button className="git-section-btn" onClick={() => withLoading(() => window.vaultApp.gitUnstage(['.']))}>
              Alle unstagen
            </button>
          )}
        </div>
        {staged.length === 0 ? (
          <div className="git-empty-hint">Keine gestagten Änderungen</div>
        ) : staged.map(f => (
          <FileRow key={f.path} file={f} staged vaultPath={vaultPath}
            onAction={unstageFile} onOpen={onFileOpen} />
        ))}
      </div>

      {/* Unstaged changes */}
      {(unstaged.length > 0 || untracked.length > 0) && (
        <div className="git-section">
          <div className="git-section-header">
            <span>Änderungen ({unstaged.length + untracked.length})</span>
            <div className="git-section-actions">
              <button className="git-section-btn" onClick={stageAll} title="Alle stagen">+</button>
              <button className="git-section-btn git-section-btn-danger" onClick={restoreAll} title="Alle zurücksetzen">↺</button>
            </div>
          </div>

          {/* Inline confirm for restore */}
          {confirmRestore !== null && (
            <div className="git-confirm-restore">
              <span>
                {confirmRestore === 'all'
                  ? 'Alle Änderungen zurücksetzen?'
                  : `„${confirmRestore.split('/').pop()}" zurücksetzen?`}
              </span>
              <div className="git-confirm-actions">
                <button className="git-section-btn git-section-btn-danger"
                  onClick={() => executeRestore(confirmRestore)}>Ja</button>
                <button className="git-section-btn"
                  onClick={() => setConfirmRestore(null)}>Abbrechen</button>
              </div>
            </div>
          )}

          {unstaged.map(f => (
            <FileRow key={f.path} file={f} staged={false} vaultPath={vaultPath}
              onAction={stageFile} onOpen={onFileOpen} onRestore={restoreFile} />
          ))}
          {untracked.map(f => (
            <FileRow key={f.path} file={f} staged={false} vaultPath={vaultPath}
              onAction={stageFile} onOpen={onFileOpen} onRestore={restoreFile} />
          ))}
        </div>
      )}

      {/* Commit */}
      <div className="git-section git-commit-section">
        <textarea
          className="git-commit-input"
          placeholder="Commit-Nachricht…"
          value={commitMsg}
          rows={3}
          onChange={e => setCommitMsg(e.target.value)}
          onKeyDown={e => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); doCommit(); }
          }}
        />
        <button
          className="btn btn-primary git-commit-btn"
          disabled={!hasStaged || !commitMsg.trim() || loading}
          onClick={doCommit}
        >
          Commit
        </button>
      </div>

      {/* Commit log */}
      <div className="git-section">
        <div
          className="git-section-header git-log-toggle"
          onClick={() => setShowLog(v => !v)}
        >
          <span>Verlauf</span>
          <span>{showLog ? '▲' : '▼'}</span>
        </div>
        {showLog && (
          <div className="git-log">
            {commits.length === 0
              ? <div className="git-empty-hint">Keine Commits</div>
              : commits.map(c => (
                <div key={c.hash} className="git-log-entry" title={c.hash}>
                  <div className="git-log-msg">{c.message}</div>
                  <div className="git-log-meta">{c.author} · {new Date(c.date).toLocaleDateString('de')}</div>
                </div>
              ))
            }
          </div>
        )}
      </div>
    </div>
  );
}
