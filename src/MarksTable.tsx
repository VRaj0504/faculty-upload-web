import { useEffect, useMemo, useRef, useState } from 'react';

// A ready-made marks table: one row per student of the picked class, one
// column per assessment. Total is worked out here; the teacher then goes on
// to set the grade cutoffs exactly as with an uploaded sheet.
//
// Default columns follow the usual IIIT Surat scheme — two quizzes of 10,
// a mid sem of 25 (20 for the lower-credit subjects) and a 50-mark end sem.
// The teacher has full control, because the split differs between subjects:
// any column can be renamed, resized or removed (no quizzes? remove them),
// and quizzes, a lab / practical, assignment, attendance or a custom column
// can be added. A Grade column follows the cutoffs live and can be
// overridden per student.

type Student = { regNo: string; name: string };
type Comp = { id: string; label: string; max: number; kind: 'quiz' | 'mid' | 'end' | 'lab' | 'other' };
export type TableMark = { regNo: string; name: string; total: number | null };

const DEFAULT_COMPS: Comp[] = [
  { id: 'q1', label: 'Quiz 1', max: 10, kind: 'quiz' },
  { id: 'q2', label: 'Quiz 2', max: 10, kind: 'quiz' },
  { id: 'mid', label: 'Mid sem', max: 25, kind: 'mid' },
  { id: 'end', label: 'End sem', max: 50, kind: 'end' },
];

const ABSENT = /^(ab|a|absent)$/i;

type Cell = { kind: 'blank' } | { kind: 'absent' } | { kind: 'bad' } | { kind: 'num'; value: number };
function readCell(raw: string, max: number): Cell {
  const t = (raw ?? '').trim();
  if (t === '') return { kind: 'blank' };
  if (ABSENT.test(t)) return { kind: 'absent' };
  const n = Number(t.replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > max) return { kind: 'bad' };
  return { kind: 'num', value: n };
}

const round = (n: number) => Math.round(n * 100) / 100;

const GRADE_CHOICES = ['AA', 'AB', 'BB', 'BC', 'CC', 'CD', 'DD', 'FF'];

const ADD_OPTIONS: { value: string; label: string; make: (n: number) => Omit<Comp, 'id'> }[] = [
  { value: 'quiz', label: 'Quiz', make: (n) => ({ label: `Quiz ${n + 1}`, max: 10, kind: 'quiz' }) },
  { value: 'mid', label: 'Mid sem', make: () => ({ label: 'Mid sem', max: 25, kind: 'mid' }) },
  { value: 'end', label: 'End sem', make: () => ({ label: 'End sem', max: 50, kind: 'end' }) },
  { value: 'lab', label: 'Lab / Practical', make: () => ({ label: 'Lab', max: 50, kind: 'lab' }) },
  { value: 'assignment', label: 'Assignment', make: () => ({ label: 'Assignment', max: 10, kind: 'other' }) },
  { value: 'attendance', label: 'Attendance', make: () => ({ label: 'Attendance', max: 5, kind: 'other' }) },
  { value: 'custom', label: 'Custom column', make: () => ({ label: 'Other', max: 10, kind: 'other' }) },
];

export default function MarksTable({
  students,
  draftKey,
  onMarks,
  gradeFor,
  overrides,
  onOverride,
  aboveTable,
}: {
  students: Student[];
  draftKey: string;
  // Called with the current marks after every change (null while any cell is
  // invalid), so grading below always works from what is on screen.
  onMarks: (marks: TableMark[] | null, absent: string[]) => void;
  gradeFor: (total: number | null) => string | null;
  overrides: Record<string, string>;
  onOverride: (regNo: string, grade: string | null) => void;
  aboveTable?: React.ReactNode;
}) {
  const [comps, setComps] = useState<Comp[]>(DEFAULT_COMPS);
  const [cells, setCells] = useState<Record<string, Record<string, string>>>({});
  const [loadedKey, setLoadedKey] = useState('');
  const tableRef = useRef<HTMLTableElement>(null);

  const rows = useMemo(() => [...students].sort((a, b) => a.regNo.localeCompare(b.regNo)), [students]);

  // Restore (or reset) the draft whenever the class / subject changes, so a
  // half-entered sheet survives a reload or an accidental tab close.
  useEffect(() => {
    let saved: { comps?: Comp[]; cells?: Record<string, Record<string, string>> } | null = null;
    try {
      saved = JSON.parse(localStorage.getItem(`marksDraft:${draftKey}`) ?? 'null');
    } catch {
      saved = null;
    }
    setComps(saved?.comps?.length ? saved.comps : DEFAULT_COMPS);
    setCells(saved?.cells ?? {});
    setLoadedKey(draftKey);
  }, [draftKey]);

  useEffect(() => {
    if (loadedKey !== draftKey) return;
    try {
      localStorage.setItem(`marksDraft:${draftKey}`, JSON.stringify({ comps, cells }));
    } catch {
      /* private mode — the table still works, it just isn't remembered */
    }
  }, [comps, cells, draftKey, loadedKey]);

  const touch = () => {};

  const setCell = (regNo: string, compId: string, value: string) => {
    touch();
    setCells((prev) => ({ ...prev, [regNo]: { ...(prev[regNo] ?? {}), [compId]: value } }));
  };

  const updateComp = (id: string, patch: Partial<Comp>) => {
    touch();
    setComps((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  };
  const addComp = (value: string) => {
    const opt = ADD_OPTIONS.find((o) => o.value === value);
    if (!opt) return;
    setComps((prev) => {
      const made = opt.make(prev.filter((c) => c.kind === 'quiz').length);
      const comp: Comp = { id: `${value}${Date.now()}`, ...made };
      // Keep a sensible order: quizzes, mid sem, lab/others, end sem last.
      const rank = (k: Comp['kind']) => ({ quiz: 0, mid: 1, lab: 2, other: 3, end: 4 })[k];
      const next = [...prev];
      let at = next.length;
      for (let k = next.length - 1; k >= 0; k--) {
        if (rank(next[k].kind) <= rank(comp.kind)) {
          at = k + 1;
          break;
        }
        at = k;
      }
      next.splice(at, 0, comp);
      return next;
    });
  };
  const removeComp = (id: string) => {
    setComps((prev) => (prev.length > 1 ? prev.filter((c) => c.id !== id) : prev));
  };

  const maxTotal = round(comps.reduce((s, c) => s + (Number(c.max) || 0), 0));

  const computed = useMemo(
    () =>
      rows.map((s) => {
        let total = 0;
        let numeric = 0;
        let blanks = 0;
        let bad = 0;
        let absents = 0;
        for (const c of comps) {
          const cell = readCell(cells[s.regNo]?.[c.id] ?? '', Number(c.max) || 0);
          if (cell.kind === 'num') {
            total += cell.value;
            numeric++;
          } else if (cell.kind === 'blank') blanks++;
          else if (cell.kind === 'bad') bad++;
          else absents++;
        }
        return { regNo: s.regNo, name: s.name, total: numeric ? round(total) : null, blanks, bad, absents, numeric };
      }),
    [rows, comps, cells],
  );

  const badCells = computed.reduce((n, r) => n + r.bad, 0);
  const noMarks = computed.filter((r) => r.total === null);
  const partial = computed.filter((r) => r.total !== null && r.blanks > 0);

  // Move with Enter / arrow keys like a spreadsheet, and let a column pasted
  // from Excel fill downwards (and across, if several columns are copied).
  const focusCell = (r: number, c: number) => {
    tableRef.current?.querySelector<HTMLInputElement>(`input[data-cell="${r}-${c}"]`)?.focus();
  };
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>, r: number, c: number) => {
    if (e.key === 'Enter' || e.key === 'ArrowDown') {
      e.preventDefault();
      focusCell(r + 1, c);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusCell(r - 1, c);
    }
  };
  const onPaste = (e: React.ClipboardEvent<HTMLInputElement>, r: number, c: number) => {
    const text = e.clipboardData.getData('text');
    if (!/[\n\t]/.test(text.trim())) return; // a single value pastes normally
    e.preventDefault();
    touch();
    const grid = text.replace(/\r/g, '').replace(/\n+$/, '').split('\n').map((line) => line.split('\t'));
    setCells((prev) => {
      const next = { ...prev };
      grid.forEach((line, dr) => {
        const row = rows[r + dr];
        if (!row) return;
        const rowCells = { ...(next[row.regNo] ?? {}) };
        line.forEach((val, dc) => {
          const comp = comps[c + dc];
          if (comp) rowCells[comp.id] = val.trim();
        });
        next[row.regNo] = rowCells;
      });
      return next;
    });
  };

  const clearAll = () => {
    if (!confirm('Clear every mark in this table?')) return;
    touch();
    setCells({});
  };

  // Push the current marks up after every change.
  useEffect(() => {
    if (badCells > 0 || loadedKey !== draftKey || computed.every((r) => r.total === null)) {
      onMarks(null, []);
      return;
    }
    onMarks(
      computed.map((r) => ({ regNo: r.regNo, name: r.name, total: r.total })),
      computed.filter((r) => r.total === null).map((r) => `${r.regNo} (${r.name})`),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [computed, badCells, loadedKey, draftKey]);

  if (rows.length === 0) {
    return <p className="res-hint" style={{ marginTop: '1rem' }}>No students found for this class in the roster.</p>;
  }

  const mid = comps.find((c) => c.kind === 'mid');

  return (
    <div className="marks-table-wrap">
      <div className="marks-tools">
        <div className="marks-tools-row">
          {mid && (
            <span className="marks-preset">
              Mid sem out of
              {[25, 20].map((n) => (
                <button
                  key={n}
                  type="button"
                  className={Number(mid.max) === n ? '' : 'button-secondary'}
                  aria-pressed={Number(mid.max) === n}
                  onClick={() => updateComp(mid.id, { max: n })}
                >
                  {n}
                </button>
              ))}
            </span>
          )}
          <select
            className="marks-add"
            value=""
            aria-label="Add a column"
            onChange={(e) => {
              if (e.target.value) addComp(e.target.value);
            }}
          >
            <option value="">+ Add column…</option>
            {ADD_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <button type="button" className="button-secondary" onClick={clearAll}>Clear marks</button>
        </div>
        <p className="res-hint" style={{ margin: '0.5rem 0 0' }}>
          Every column is yours to shape — rename it, change its maximum, remove it (no quizzes? lab only?) or add
          more. Type marks, or copy a column from Excel and paste it into the first cell. <b>AB</b> = absent. Enter or
          ↓ moves down. Saved on this computer as you type.
        </p>
      </div>

      {aboveTable}

      <div className="marks-scroll">
        <table className="marks-table" ref={tableRef}>
          <thead>
            <tr>
              <th className="m-no">#</th>
              <th className="m-reg">Enrollment No</th>
              <th className="m-name">Name</th>
              {comps.map((c) => (
                <th key={c.id} className="m-comp">
                  <input
                    className="m-label"
                    value={c.label}
                    aria-label="Column name"
                    onChange={(e) => updateComp(c.id, { label: e.target.value })}
                  />
                  <span className="m-max">
                    out of
                    <input
                      type="number"
                      min={0}
                      value={c.max}
                      aria-label={`${c.label} maximum marks`}
                      onChange={(e) => updateComp(c.id, { max: Number(e.target.value) })}
                    />
                  </span>
                  {comps.length > 1 && (
                    <button type="button" className="m-remove" aria-label={`Remove ${c.label}`} onClick={() => removeComp(c.id)}>
                      ×
                    </button>
                  )}
                </th>
              ))}
              <th className="m-total">
                Total
                <span className="m-max">out of {maxTotal}</span>
              </th>
              <th className="m-grade">Grade</th>
            </tr>
          </thead>
          <tbody>
            {computed.map((row, r) => (
              <tr key={row.regNo} className={row.total === null ? 'm-empty' : undefined}>
                <td className="m-no">{r + 1}</td>
                <td className="m-reg">{row.regNo}</td>
                <td className="m-name">{row.name}</td>
                {comps.map((c, ci) => {
                  const raw = cells[row.regNo]?.[c.id] ?? '';
                  const cell = readCell(raw, Number(c.max) || 0);
                  return (
                    <td key={c.id} className="m-comp">
                      <input
                        data-cell={`${r}-${ci}`}
                        inputMode="decimal"
                        value={raw}
                        className={cell.kind === 'bad' ? 'm-bad' : cell.kind === 'absent' ? 'm-ab' : undefined}
                        title={cell.kind === 'bad' ? `Must be 0 to ${c.max}, or AB` : undefined}
                        onChange={(e) => setCell(row.regNo, c.id, e.target.value)}
                        onKeyDown={(e) => onKey(e, r, ci)}
                        onPaste={(e) => onPaste(e, r, ci)}
                      />
                    </td>
                  );
                })}
                <td className="m-total">{row.total === null ? '—' : row.total}</td>
                <td className="m-grade">
                  {(() => {
                    const auto = gradeFor(row.total);
                    const over = overrides[row.regNo];
                    const shown = over ?? auto;
                    return (
                      <select
                        value={over ?? ''}
                        className={`m-grade-pick${over ? ' m-over' : ''}${shown === 'FF' ? ' m-ff' : ''}`}
                        title={over ? `Overridden (marks say ${auto ?? '—'})` : 'Follows the cutoffs — pick a grade to override'}
                        onChange={(e) => onOverride(row.regNo, e.target.value || null)}
                      >
                        <option value="">{auto ?? '—'}</option>
                        {GRADE_CHOICES.map((g) => (
                          <option key={g} value={g}>{g}{g === auto ? ' (auto)' : ''}</option>
                        ))}
                      </select>
                    );
                  })()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {badCells > 0 && (
        <div className="notice notice-error" style={{ display: 'block' }}>
          {badCells} cell{badCells === 1 ? ' is' : 's are'} not valid (red) — a mark must be a number from 0 up to that
          column's maximum, or AB.
        </div>
      )}
      {badCells === 0 && noMarks.length > 0 && noMarks.length < computed.length && (
        <div className="notice" style={{ display: 'block', background: 'var(--tone-yellow-bg)', color: 'var(--tone-yellow-fg)' }}>
          <strong>{noMarks.length} student{noMarks.length === 1 ? ' has' : 's have'} no marks at all</strong> and will be
          graded FF (absent): {noMarks.slice(0, 8).map((r) => r.name).join(', ')}
          {noMarks.length > 8 ? `, +${noMarks.length - 8} more` : ''}.
        </div>
      )}
      {badCells === 0 && partial.length > 0 && (
        <p className="res-hint">
          {partial.length} student{partial.length === 1 ? ' has' : 's have'} some blank columns — blanks count as 0.
          Type AB if the student was absent for that part.
        </p>
      )}

    </div>
  );
}
