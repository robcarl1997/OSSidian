import { useState, useEffect, useCallback, useMemo } from 'react';
import type { AppSettings, CalendarNote, CalendarSavedView } from '../../../shared/ipc';

interface CalendarViewProps {
  vaultPath: string;
  settings: AppSettings;
  onOpenNote: (path: string) => void;
  onCreateDailyNote: (date: string) => void;
  onSaveSettings: (partial: Partial<AppSettings>) => void;
  initialDate?: string; // YYYY-MM format
  initialView?: string; // saved view name
}

const DAY_NAMES = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const MONTH_NAMES = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

export default function CalendarView({
  settings,
  onOpenNote,
  onCreateDailyNote,
  onSaveSettings,
  initialDate,
  initialView,
}: CalendarViewProps) {
  const now = new Date();
  const [year, setYear] = useState(() => {
    if (initialDate) {
      const parts = initialDate.split('-');
      return parseInt(parts[0], 10);
    }
    return now.getFullYear();
  });
  const [month, setMonth] = useState(() => {
    if (initialDate) {
      const parts = initialDate.split('-');
      return parseInt(parts[1], 10);
    }
    return now.getMonth() + 1;
  });
  const [notes, setNotes] = useState<CalendarNote[]>([]);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [activeView, setActiveView] = useState<string | null>(initialView ?? null);
  const [filterKey, setFilterKey] = useState('');
  const [filterValue, setFilterValue] = useState('');
  const [selectedDay, setSelectedDay] = useState<number | null>(null);
  const [viewNameInput, setViewNameInput] = useState('');
  const [showSaveView, setShowSaveView] = useState(false);

  const savedViews: CalendarSavedView[] = settings.calendarViews ?? [];

  // Apply initial saved view filters on mount
  useEffect(() => {
    if (initialView) {
      const view = savedViews.find(v => v.name === initialView);
      if (view) {
        setFilters(view.filters);
        setActiveView(initialView);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch notes whenever year, month, or filters change
  useEffect(() => {
    window.vaultApp.getCalendarNotes(year, month, Object.keys(filters).length > 0 ? filters : undefined)
      .then(setNotes)
      .catch(() => setNotes([]));
  }, [year, month, filters]);

  // Build a map from day number to notes for quick lookup
  const notesByDay = useMemo(() => {
    const map = new Map<number, CalendarNote[]>();
    for (const note of notes) {
      const day = parseInt(note.date.split('-')[2], 10);
      const existing = map.get(day) ?? [];
      existing.push(note);
      map.set(day, existing);
    }
    return map;
  }, [notes]);

  // Calendar grid computation
  const daysInMonth = new Date(year, month, 0).getDate();
  // getDay() returns 0=Sun, convert to Mon-based (0=Mon)
  const firstDayOfWeek = (() => {
    const d = new Date(year, month - 1, 1).getDay();
    return d === 0 ? 6 : d - 1;
  })();

  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  // Navigation
  const prevMonth = useCallback(() => {
    setSelectedDay(null);
    if (month === 1) { setYear(y => y - 1); setMonth(12); }
    else setMonth(m => m - 1);
  }, [month]);

  const nextMonth = useCallback(() => {
    setSelectedDay(null);
    if (month === 12) { setYear(y => y + 1); setMonth(1); }
    else setMonth(m => m + 1);
  }, [month]);

  const goToToday = useCallback(() => {
    setYear(now.getFullYear());
    setMonth(now.getMonth() + 1);
    setSelectedDay(now.getDate());
  }, [now]);

  // Filter management
  const addFilter = useCallback(() => {
    const k = filterKey.trim();
    const v = filterValue.trim();
    if (!k || !v) return;
    setFilters(prev => ({ ...prev, [k]: v }));
    setFilterKey('');
    setFilterValue('');
    setActiveView(null);
  }, [filterKey, filterValue]);

  const removeFilter = useCallback((key: string) => {
    setFilters(prev => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    setActiveView(null);
  }, []);

  const resetFilters = useCallback(() => {
    setFilters({});
    setActiveView(null);
  }, []);

  // Saved view management
  const saveView = useCallback(() => {
    const name = viewNameInput.trim();
    if (!name) return;
    const existing = savedViews.filter(v => v.name !== name);
    const updated = [...existing, { name, filters: { ...filters } }];
    onSaveSettings({ calendarViews: updated });
    setActiveView(name);
    setShowSaveView(false);
    setViewNameInput('');
  }, [viewNameInput, filters, savedViews, onSaveSettings]);

  const loadView = useCallback((view: CalendarSavedView) => {
    setFilters(view.filters);
    setActiveView(view.name);
  }, []);

  const deleteView = useCallback((name: string) => {
    const updated = savedViews.filter(v => v.name !== name);
    onSaveSettings({ calendarViews: updated });
    if (activeView === name) setActiveView(null);
  }, [savedViews, activeView, onSaveSettings]);

  // Click on a day
  const handleDayClick = useCallback((day: number) => {
    setSelectedDay(day);
  }, []);

  // Double-click on a day: open or create daily note
  const handleDayDoubleClick = useCallback((day: number) => {
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const dayNotes = notesByDay.get(day);
    if (dayNotes && dayNotes.length > 0) {
      // If there's a daily note (filename = date), open it
      const daily = dayNotes.find(n => n.name === dateStr);
      if (daily) {
        onOpenNote(daily.path);
      } else {
        // Open the first note for that day
        onOpenNote(dayNotes[0].path);
      }
    } else {
      // Create a new daily note
      onCreateDailyNote(dateStr);
    }
  }, [year, month, notesByDay, onOpenNote, onCreateDailyNote]);

  // Notes for the selected day
  const selectedDayNotes = selectedDay ? (notesByDay.get(selectedDay) ?? []) : [];

  // Build the grid rows
  const gridCells: (number | null)[] = [];
  for (let i = 0; i < firstDayOfWeek; i++) gridCells.push(null);
  for (let d = 1; d <= daysInMonth; d++) gridCells.push(d);
  while (gridCells.length % 7 !== 0) gridCells.push(null);

  // Collect unique frontmatter keys from current notes for autocomplete hints
  const fmKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const note of notes) {
      for (const k of Object.keys(note.frontmatter)) {
        keys.add(k);
      }
    }
    return Array.from(keys).sort();
  }, [notes]);

  return (
    <div className="calendar-view">
      {/* ── Saved Views bar ─────────────────────────────────────── */}
      <div className="calendar-views">
        {savedViews.map(v => (
          <div
            key={v.name}
            className={`calendar-view-tab${activeView === v.name ? ' active' : ''}`}
            onClick={() => loadView(v)}
          >
            <span>{v.name}</span>
            <button
              className="calendar-view-tab-close"
              title="Ansicht entfernen"
              onClick={e => { e.stopPropagation(); deleteView(v.name); }}
            >
              x
            </button>
          </div>
        ))}
        {showSaveView ? (
          <div className="calendar-save-view-input">
            <input
              type="text"
              placeholder="Ansichtsname..."
              value={viewNameInput}
              onChange={e => setViewNameInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') saveView(); if (e.key === 'Escape') setShowSaveView(false); }}
              autoFocus
            />
            <button className="calendar-btn calendar-btn-sm" onClick={saveView}>Speichern</button>
            <button className="calendar-btn calendar-btn-sm calendar-btn-secondary" onClick={() => setShowSaveView(false)}>Abbrechen</button>
          </div>
        ) : (
          <button
            className="calendar-btn calendar-btn-sm"
            onClick={() => setShowSaveView(true)}
            title="Aktuelle Filter als Ansicht speichern"
          >
            + Ansicht speichern
          </button>
        )}
      </div>

      {/* ── Filter bar ──────────────────────────────────────────── */}
      <div className="calendar-filters">
        {Object.keys(filters).length > 0 && (
          <div className="calendar-filter-chips">
            {Object.entries(filters).map(([k, v]) => (
              <span key={k} className="calendar-filter-chip">
                {k}={v}
                <button
                  className="calendar-filter-chip-remove"
                  onClick={() => removeFilter(k)}
                  title="Filter entfernen"
                >
                  x
                </button>
              </span>
            ))}
            <button className="calendar-btn calendar-btn-sm calendar-btn-secondary" onClick={resetFilters}>
              Alle Filter entfernen
            </button>
          </div>
        )}
        <div className="calendar-filter-add">
          <input
            type="text"
            className="calendar-filter-input"
            placeholder="Schlüssel"
            list="calendar-fm-keys"
            value={filterKey}
            onChange={e => setFilterKey(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') addFilter(); }}
          />
          <datalist id="calendar-fm-keys">
            {fmKeys.map(k => <option key={k} value={k} />)}
          </datalist>
          <input
            type="text"
            className="calendar-filter-input"
            placeholder="Wert"
            value={filterValue}
            onChange={e => setFilterValue(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') addFilter(); }}
          />
          <button className="calendar-btn calendar-btn-sm" onClick={addFilter}>
            + Hinzufügen
          </button>
        </div>
      </div>

      {/* ── Month/year header ───────────────────────────────────── */}
      <div className="calendar-header">
        <button className="calendar-nav-btn" onClick={prevMonth} title="Vorheriger Monat">&lsaquo;</button>
        <span className="calendar-month-label">{MONTH_NAMES[month - 1]} {year}</span>
        <button className="calendar-nav-btn" onClick={nextMonth} title="Nächster Monat">&rsaquo;</button>
        <button className="calendar-btn calendar-btn-sm calendar-today-btn" onClick={goToToday}>Heute</button>
      </div>

      {/* ── Day grid ────────────────────────────────────────────── */}
      <div className="calendar-grid">
        {DAY_NAMES.map(d => (
          <div key={d} className="calendar-day-name">{d}</div>
        ))}
        {gridCells.map((day, idx) => {
          if (day === null) {
            return <div key={`empty-${idx}`} className="calendar-day calendar-day-empty" />;
          }
          const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          const dayNotes = notesByDay.get(day);
          const hasNotes = dayNotes && dayNotes.length > 0;
          const isToday = dateStr === todayStr;
          const isSelected = day === selectedDay;

          return (
            <div
              key={day}
              className={[
                'calendar-day',
                hasNotes ? 'has-notes' : '',
                isToday ? 'today' : '',
                isSelected ? 'selected' : '',
              ].filter(Boolean).join(' ')}
              onClick={() => handleDayClick(day)}
              onDoubleClick={() => handleDayDoubleClick(day)}
              title={hasNotes ? `${dayNotes!.length} Notiz${dayNotes!.length > 1 ? 'en' : ''}` : undefined}
            >
              <span className="calendar-day-number">{day}</span>
              {hasNotes && (
                <div className="calendar-day-dots">
                  {dayNotes!.slice(0, 3).map((_, i) => (
                    <span key={i} className="calendar-day-dot" />
                  ))}
                  {dayNotes!.length > 3 && <span className="calendar-day-dot-more">+</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ── Notes for selected day ──────────────────────────────── */}
      {selectedDay !== null && (
        <div className="calendar-day-notes">
          <div className="calendar-day-notes-header">
            Notizen am {selectedDay}.{month}.{year}:
          </div>
          {selectedDayNotes.length === 0 ? (
            <div className="calendar-day-notes-empty">
              Keine Notizen
              <button
                className="calendar-btn calendar-btn-sm"
                style={{ marginLeft: 8 }}
                onClick={() => handleDayDoubleClick(selectedDay)}
              >
                Tägliche Notiz erstellen
              </button>
            </div>
          ) : (
            <div className="calendar-day-notes-list">
              {selectedDayNotes.map(note => {
                const isDaily = /^\d{4}-\d{2}-\d{2}$/.test(note.name);
                const fmEntries = Object.entries(note.frontmatter).filter(([k]) => k !== 'date' && k !== 'created');
                return (
                  <div
                    key={note.path}
                    className="calendar-day-note-item"
                    onClick={() => onOpenNote(note.path)}
                  >
                    <span className="calendar-day-note-name">{note.name}.md</span>
                    {isDaily && <span className="calendar-day-note-tag">Tägliche Notiz</span>}
                    {fmEntries.length > 0 && (
                      <span className="calendar-day-note-meta">
                        {fmEntries.slice(0, 3).map(([k, v]) => `${k}:${v}`).join(' ')}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
