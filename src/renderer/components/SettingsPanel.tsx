import React, { useState, useCallback } from 'react';
import type { AppSettings, Theme, VimKeybinding, AppKeybinding, AppAction } from '../../../shared/ipc';
import { DEFAULT_SETTINGS } from '../../../shared/ipc';

// ─── Props ────────────────────────────────────────────────────────────────────

interface SettingsPanelProps {
  settings: AppSettings;
  onSave: (updated: Partial<AppSettings>) => void;
  onClose: () => void;
}

type SettingsTab = 'appearance' | 'vim' | 'markdown' | 'keybindings';

// ─── Theme swatches ───────────────────────────────────────────────────────────

const THEMES: { id: Theme; label: string; bg: string; text: string }[] = [
  { id: 'dark',  label: 'Dunkel', bg: '#1e1e2e', text: '#cdd6f4' },
  { id: 'light', label: 'Hell',   bg: '#f8f8f8', text: '#2c2c2c' },
  { id: 'sepia', label: 'Sepia',  bg: '#f5ede1', text: '#3d2b1f' },
];

// ─── Toggle ───────────────────────────────────────────────────────────────────

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
      <span className="toggle-track" />
      <span className="toggle-thumb" />
    </label>
  );
}

// ─── Appearance tab ───────────────────────────────────────────────────────────

function AppearanceTab({
  local,
  setLocal,
}: {
  local: Partial<AppSettings>;
  setLocal: React.Dispatch<React.SetStateAction<Partial<AppSettings>>>;
}) {
  const theme      = (local.theme      ?? 'dark') as Theme;
  const fontFamily = local.editorFontFamily ?? "ui-serif, Georgia, serif";
  const fontSize   = local.editorFontSize   ?? 17;
  const lineHeight = local.editorLineHeight ?? 1.75;

  return (
    <div className="settings-body">
      {/* Theme */}
      <div className="settings-section">
        <div className="settings-section-title">Design</div>
        <div className="theme-picker">
          {THEMES.map(t => (
            <button
              key={t.id}
              className={`theme-btn${theme === t.id ? ' active' : ''}`}
              onClick={() => setLocal(l => ({ ...l, theme: t.id }))}
            >
              <span
                className="theme-swatch"
                style={{ background: t.bg, border: `1px solid ${t.text}22` }}
              />
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Font family */}
      <div className="settings-section">
        <div className="settings-section-title">Schriftart</div>
        <div className="settings-row">
          <div className="settings-label">
            Editor-Schriftart
            <small>CSS font-family Wert</small>
          </div>
          <input
            className="settings-text-input"
            value={fontFamily}
            onChange={e => setLocal(l => ({ ...l, editorFontFamily: e.target.value }))}
          />
        </div>
        <div style={{ marginTop: 6, fontFamily, fontSize: 14, color: 'var(--text-muted)', padding: '6px 12px', background: 'var(--bg-hover)', borderRadius: 5 }}>
          Vorschau: Das ist ein **Beispieltext** mit der gewählten Schrift.
        </div>
      </div>

      {/* Font size */}
      <div className="settings-section">
        <div className="settings-section-title">Schriftgröße & Zeilenabstand</div>
        <div className="settings-row">
          <div className="settings-label">Schriftgröße</div>
          <div className="slider-row">
            <input
              type="range"
              className="settings-slider"
              min={12}
              max={28}
              step={1}
              value={fontSize}
              onChange={e => setLocal(l => ({ ...l, editorFontSize: Number(e.target.value) }))}
            />
            <span className="slider-value">{fontSize}px</span>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-label">Zeilenhöhe</div>
          <div className="slider-row">
            <input
              type="range"
              className="settings-slider"
              min={1.0}
              max={2.5}
              step={0.05}
              value={lineHeight}
              onChange={e => setLocal(l => ({ ...l, editorLineHeight: Number(e.target.value) }))}
            />
            <span className="slider-value">{lineHeight.toFixed(2)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Vim tab ──────────────────────────────────────────────────────────────────

function VimTab({
  local,
  setLocal,
}: {
  local: Partial<AppSettings>;
  setLocal: React.Dispatch<React.SetStateAction<Partial<AppSettings>>>;
}) {
  const vimMode      = local.vimMode ?? false;
  const keybindings  = (local.vimKeybindings ?? []) as VimKeybinding[];
  const vimLeader    = local.vimLeader ?? '\\';

  // Display helpers for leader key: space → '<Space>', tab → '<Tab>'
  const leaderDisplay = vimLeader === ' ' ? '<Space>' : vimLeader === '\t' ? '<Tab>' : vimLeader;
  const handleLeaderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    const val = raw.toLowerCase() === '<space>' ? ' '
              : raw.toLowerCase() === '<tab>'   ? '\t'
              : raw;
    setLocal(l => ({ ...l, vimLeader: val }));
  };

  const addBinding = () =>
    setLocal(l => ({
      ...l,
      vimKeybindings: [...(l.vimKeybindings ?? []), { lhs: '', rhs: '', mode: 'insert' }],
    }));

  const updateBinding = (idx: number, patch: Partial<VimKeybinding>) =>
    setLocal(l => ({
      ...l,
      vimKeybindings: (l.vimKeybindings ?? []).map((b, i) => i === idx ? { ...b, ...patch } : b),
    }));

  const removeBinding = (idx: number) =>
    setLocal(l => ({
      ...l,
      vimKeybindings: (l.vimKeybindings ?? []).filter((_, i) => i !== idx),
    }));

  return (
    <div className="settings-body">
      <div className="settings-section">
        <div className="settings-section-title">Vim-Modus</div>
        <div className="settings-row">
          <div className="settings-label">
            Vim-Modus aktivieren
            <small>Normaler, Insert- und Visual-Mode wie in Vim</small>
          </div>
          <Toggle checked={vimMode} onChange={v => setLocal(l => ({ ...l, vimMode: v }))} />
        </div>
      </div>

      {vimMode && (
        <div className="settings-section">
          <div className="settings-section-title">Vim-Einstellungen</div>
          <div className="settings-row">
            <div className="settings-label">
              Leader-Taste
              <small>Wird als &lt;leader&gt; in Mappings verwendet</small>
            </div>
            <input
              className="kb-input"
              style={{ width: 80 }}
              value={leaderDisplay}
              onChange={handleLeaderChange}
              placeholder="\"
            />
          </div>
        </div>
      )}

      {vimMode && (
        <div className="settings-section">
          <div className="settings-section-title">Tastenbelegung</div>
          <table className="keybinding-table">
            <thead>
              <tr>
                <th>Von (LHS)</th>
                <th>Nach (RHS)</th>
                <th>Modus</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {keybindings.map((kb, idx) => (
                <tr key={idx}>
                  <td>
                    <input
                      className="kb-input"
                      placeholder="jk"
                      value={kb.lhs}
                      onChange={e => updateBinding(idx, { lhs: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      className="kb-input"
                      placeholder="<Esc>"
                      value={kb.rhs}
                      onChange={e => updateBinding(idx, { rhs: e.target.value })}
                    />
                  </td>
                  <td>
                    <select
                      className="kb-select"
                      value={kb.mode}
                      onChange={e => updateBinding(idx, { mode: e.target.value as VimKeybinding['mode'] })}
                    >
                      <option value="insert">Insert</option>
                      <option value="normal">Normal</option>
                      <option value="visual">Visual</option>
                    </select>
                  </td>
                  <td>
                    <button className="kb-remove" onClick={() => removeBinding(idx)}>×</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button className="add-keybinding-btn" onClick={addBinding}>
            + Tastenbelegung hinzufügen
          </button>
          <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-faint)' }}>
            Beispiel: <code>jk</code> → <code>&lt;Esc&gt;</code> im Insert-Modus beendet den Insert-Modus.
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Markdown tab ─────────────────────────────────────────────────────────────

function MarkdownTab({
  local,
  setLocal,
}: {
  local: Partial<AppSettings>;
  setLocal: React.Dispatch<React.SetStateAction<Partial<AppSettings>>>;
}) {
  const editorMode      = local.editorMode      ?? 'live-preview';
  const linkFormat      = local.linkFormat      ?? 'wikilink';
  const autoUpdateLinks = local.autoUpdateLinks ?? true;
  const attachmentFolder = local.attachmentFolder ?? 'attachments';

  return (
    <div className="settings-body">
      <div className="settings-section">
        <div className="settings-section-title">Editor-Modus</div>
        <div className="settings-row">
          <div className="settings-label">
            Rendering-Modus
            <small>Live-Preview rendert Markdown inline; Source zeigt Rohtext</small>
          </div>
          <div className="radio-group">
            <button
              className={`radio-btn${editorMode === 'live-preview' ? ' active' : ''}`}
              onClick={() => setLocal(l => ({ ...l, editorMode: 'live-preview' }))}
            >
              Live Preview
            </button>
            <button
              className={`radio-btn${editorMode === 'source' ? ' active' : ''}`}
              onClick={() => setLocal(l => ({ ...l, editorMode: 'source' }))}
            >
              Quelltext
            </button>
          </div>
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">Verlinkungen</div>
        <div className="settings-row">
          <div className="settings-label">
            Link-Format
            <small>Format für neu erstellte Links</small>
          </div>
          <div className="radio-group">
            <button
              className={`radio-btn${linkFormat === 'wikilink' ? ' active' : ''}`}
              onClick={() => setLocal(l => ({ ...l, linkFormat: 'wikilink' }))}
            >
              [[Wikilink]]
            </button>
            <button
              className={`radio-btn${linkFormat === 'markdown' ? ' active' : ''}`}
              onClick={() => setLocal(l => ({ ...l, linkFormat: 'markdown' }))}
            >
              [Markdown](link)
            </button>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-label">
            Links automatisch aktualisieren
            <small>Beim Umbenennen einer Notiz werden alle Links angepasst</small>
          </div>
          <Toggle
            checked={autoUpdateLinks}
            onChange={v => setLocal(l => ({ ...l, autoUpdateLinks: v }))}
          />
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">Anhänge</div>
        <div className="settings-row">
          <div className="settings-label">
            Anhang-Ordner
            <small>Ordner relativ zum Vault-Root für eingefügte Bilder</small>
          </div>
          <input
            className="settings-text-input"
            value={attachmentFolder}
            placeholder="attachments"
            onChange={e => setLocal(l => ({ ...l, attachmentFolder: e.target.value }))}
          />
        </div>

        <div className="settings-row">
          <div className="settings-label">Terminal-Position</div>
          <select
            className="settings-select"
            value={local.terminalPosition ?? 'right'}
            onChange={e => setLocal(l => ({ ...l, terminalPosition: e.target.value as 'bottom' | 'right' }))}
          >
            <option value="right">Rechts</option>
            <option value="bottom">Unten</option>
          </select>
        </div>
      </div>
    </div>
  );
}

// ─── App keybindings tab ──────────────────────────────────────────────────────

const ACTION_LABELS: Record<AppAction, string> = {
  quickOpen:      'Datei suchen (Quick Open)',
  toggleSidebar:  'Seitenleiste umschalten',
  toggleOutline:  'Gliederung umschalten',
  focusFileTree:  'Dateibaum fokussieren',
  focusGit:       'Git-Panel öffnen',
  tabNext:        'Nächster Tab',
  tabPrev:        'Vorheriger Tab',
  tabClose:       'Tab schließen',
  jumpBack:       'Zurück navigieren',
  newNote:        'Neue Notiz erstellen',
  openSettings:   'Einstellungen öffnen',
  toggleTerminal: 'Terminal umschalten',
};

const VIM_COMMANDS: Partial<Record<AppAction, string>> = {
  quickOpen:     ':quickopen  :qu',
  toggleSidebar: ':sidebar  :si',
  toggleOutline: ':outline  :ou',
  focusFileTree: ':filetree  :ft',
  focusGit:      ':git  :gi',
  tabNext:       ':tabnext  :tabn  gt',
  tabPrev:       ':tabprev  :tabp  gT',
  tabClose:      ':tabclose  :tabc',
  jumpBack:      ':jumpback  :ju',
};

const ALL_ACTIONS = Object.keys(ACTION_LABELS) as AppAction[];

function KeyCaptureInput({ value, onChange }: { value: string; onChange: (key: string) => void }) {
  const [capturing, setCapturing] = useState(false);

  return (
    <input
      className="kb-input"
      readOnly
      value={capturing ? '…' : (value || '—')}
      title="Klicken und Tastenkombination drücken"
      onFocus={() => setCapturing(true)}
      onBlur={() => setCapturing(false)}
      onKeyDown={e => {
        if (!capturing) return;
        e.preventDefault();
        e.stopPropagation();
        if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
        if (e.key === 'Escape') { setCapturing(false); return; }
        const parts: string[] = [];
        if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
        if (e.shiftKey) parts.push('Shift');
        if (e.altKey) parts.push('Alt');
        parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);
        onChange(parts.join('+'));
        setCapturing(false);
      }}
    />
  );
}

function AppKeybindingsTab({
  local,
  setLocal,
}: {
  local: Partial<AppSettings>;
  setLocal: React.Dispatch<React.SetStateAction<Partial<AppSettings>>>;
}) {
  const bindings = (local.appKeybindings ?? DEFAULT_SETTINGS.appKeybindings) as AppKeybinding[];

  const addBinding = () =>
    setLocal(l => ({
      ...l,
      appKeybindings: [...(l.appKeybindings ?? DEFAULT_SETTINGS.appKeybindings), { key: '', action: 'quickOpen' }],
    }));

  const updateBinding = (idx: number, patch: Partial<AppKeybinding>) =>
    setLocal(l => ({
      ...l,
      appKeybindings: (l.appKeybindings ?? DEFAULT_SETTINGS.appKeybindings).map((b, i) => i === idx ? { ...b, ...patch } : b),
    }));

  const removeBinding = (idx: number) =>
    setLocal(l => ({
      ...l,
      appKeybindings: (l.appKeybindings ?? DEFAULT_SETTINGS.appKeybindings).filter((_, i) => i !== idx),
    }));

  const resetToDefaults = () =>
    setLocal(l => ({ ...l, appKeybindings: DEFAULT_SETTINGS.appKeybindings }));

  return (
    <div className="settings-body">
      <div className="settings-section">
        <div className="settings-section-title">Globale Tastenkürzel</div>
        <div style={{ marginBottom: 8, fontSize: 12, color: 'var(--text-faint)' }}>
          Klicke auf ein Feld und drücke die gewünschte Kombination. Mehrere Belegungen für dieselbe Aktion sind möglich.
        </div>
        <table className="keybinding-table">
          <thead>
            <tr>
              <th>Tastenkombination</th>
              <th>Aktion</th>
              <th>Vim-Befehl</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {bindings.map((kb, idx) => (
              <tr key={idx}>
                <td>
                  <KeyCaptureInput value={kb.key} onChange={key => updateBinding(idx, { key })} />
                </td>
                <td>
                  <select
                    className="kb-select"
                    value={kb.action}
                    onChange={e => updateBinding(idx, { action: e.target.value as AppAction })}
                  >
                    {ALL_ACTIONS.map(a => (
                      <option key={a} value={a}>{ACTION_LABELS[a]}</option>
                    ))}
                  </select>
                </td>
                <td style={{ fontSize: 11, color: 'var(--text-faint)', whiteSpace: 'nowrap', paddingLeft: 8 }}>
                  {VIM_COMMANDS[kb.action] ?? '—'}
                </td>
                <td>
                  <button className="kb-remove" onClick={() => removeBinding(idx)}>×</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button className="add-keybinding-btn" onClick={addBinding}>
            + Tastenkürzel hinzufügen
          </button>
          <button className="add-keybinding-btn" onClick={resetToDefaults} style={{ marginLeft: 'auto' }}>
            Zurücksetzen
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function SettingsPanel({ settings, onSave, onClose }: SettingsPanelProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('appearance');
  const [local, setLocal] = useState<Partial<AppSettings>>({ ...settings });

  const save = useCallback(() => {
    onSave(local);
    onClose();
  }, [local, onSave, onClose]);

  // Close on Escape
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal settings-panel" onClick={e => e.stopPropagation()}>
        <div className="modal-title">⚙️ Einstellungen</div>

        {/* Tabs */}
        <div className="settings-tabs">
          {([
            ['appearance',  '🎨 Erscheinungsbild'],
            ['vim',         '⌨️ Vim'],
            ['markdown',    '📝 Markdown'],
            ['keybindings', '🔑 Tastenkürzel'],
          ] as const).map(([id, label]) => (
            <button
              key={id}
              className={`settings-tab${activeTab === id ? ' active' : ''}`}
              onClick={() => setActiveTab(id)}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        {activeTab === 'appearance'  && <AppearanceTab      local={local} setLocal={setLocal} />}
        {activeTab === 'vim'         && <VimTab             local={local} setLocal={setLocal} />}
        {activeTab === 'markdown'    && <MarkdownTab        local={local} setLocal={setLocal} />}
        {activeTab === 'keybindings' && <AppKeybindingsTab  local={local} setLocal={setLocal} />}

        {/* Actions */}
        <div className="modal-actions" style={{ marginTop: 20, borderTop: '1px solid var(--border)', paddingTop: 16 }}>
          <button className="btn btn-secondary" onClick={onClose}>Abbrechen</button>
          <button className="btn btn-primary"   onClick={save}>Speichern</button>
        </div>
      </div>
    </div>
  );
}
