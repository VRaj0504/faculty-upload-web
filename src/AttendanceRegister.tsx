import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import AttendanceClassPicker, { type PickerState } from './AttendanceClassPicker';
import {
  LOW_ATTENDANCE,
  isFor,
  isValidIso,
  prettyDate,
  sessionDocId,
  studentRecord,
  todayIso,
  weightOf,
  type ExcusalRange,
  type RosterEntry,
  type SessionDoc,
} from './attendanceCore';
import { deleteSessions, writeSessions, type SessionWrite } from './attendanceData';
import { downloadSemesterRegister, prepare, type Prepared } from './AttendanceExport';

type Mark = 'P' | 'A' | 'OD' | 'NA';
type Doc = SessionDoc & { id: string };
type Col = { key: string; date: string; lecture: number; docs: Map<string, Doc>; isNew?: boolean; hours: number };

const NEXT: Record<Mark, Mark> = { P: 'A', A: 'OD', OD: 'NA', NA: 'P' };
const colKey = (date: string, lecture: number) => `${date}#${lecture}`;
const inRange = (d: string, from: string, to: string) => (!from || d >= from) && (!to || d <= to);
const excusedOn = (date: string, ranges?: ExcusalRange[]) => !!ranges?.some((r) => date >= r.fromDate && date <= r.toDate);

function baseMark(s: RosterEntry, col: Col): Mark {
  const d = col.docs.get(s.branch);
  if (!d) return col.isNew ? 'P' : 'NA';
  if (!isFor(d, s)) return 'NA';
  if (d.excusedEnrollmentNumbers?.includes(s.regNo)) return 'OD';
  if (d.absentEnrollmentNumbers.includes(s.regNo)) return 'A';
  return 'P';
}

export default function AttendanceRegister() {
  const [ctx, setCtx] = useState<PickerState | null>(null);
  const [data, setData] = useState<Prepared | null>(null);
  const [error, setError] = useState('');
  const [threshold, setThreshold] = useState(LOW_ATTENDANCE);
  const [onlyLow, setOnlyLow] = useState(false);
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [dayView, setDayView] = useState(todayIso());

  const [edits, setEdits] = useState<Map<string, Map<string, Mark>>>(new Map());
  const [newCols, setNewCols] = useState<{ date: string; lecture: number; hours: number }[]>([]);
  const [addHours, setAddHours] = useState(1);
  const [openCol, setOpenCol] = useState<string | null>(null);
  const [addDate, setAddDate] = useState(todayIso());
  const [busy, setBusy] = useState('');
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const key = ctx ? `${ctx.batch!.key}|${ctx.cls!.key}|${ctx.semester}|${ctx.subject?.code ?? '*'}|${ctx.specialization}` : '';
  const dirty = edits.size > 0 || newCols.length > 0;

  const reload = useCallback(async () => {
    if (!ctx) return;
    setData(await prepare(ctx, ctx.subject));
  }, [ctx]);

  useEffect(() => {
    setData(null);
    setError('');
    setEdits(new Map());
    setNewCols([]);
    setOpenCol(null);
    setStatus(null);
    if (!ctx) return;
    let live = true;
    prepare(ctx, ctx.subject)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(`Couldn’t load attendance: ${e.message}`));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const students = ctx?.students ?? [];
  const excusals = data?.excusals.map ?? new Map<string, ExcusalRange[]>();
  const q = search.trim().toLowerCase();

  const subject = ctx?.subject && data ? data.subjects[0] : null;
  const cols: Col[] = useMemo(() => {
    if (!subject) return [];
    const m = new Map<string, Col>();
    for (const d of subject.sessions as Doc[]) {
      const k = colKey(d.date, d.lecture ?? 1);
      if (!m.has(k)) m.set(k, { key: k, date: d.date, lecture: d.lecture ?? 1, docs: new Map(), hours: weightOf(d) });
      m.get(k)!.docs.set(d.branch, d);
    }
    for (const n of newCols) {
      const k = colKey(n.date, n.lecture);
      if (!m.has(k)) m.set(k, { key: k, date: n.date, lecture: n.lecture, docs: new Map(), isNew: true, hours: n.hours });
    }
    return Array.from(m.values()).sort((a, b) => a.key.localeCompare(b.key));
  }, [subject, newCols]);
  const shownCols = cols.filter((c) => inRange(c.date, from, to));

  const markOf = (s: RosterEntry, c: Col): Mark => edits.get(c.key)?.get(s.regNo) ?? baseMark(s, c);

  const setCell = (s: RosterEntry, c: Col, m: Mark) => {
    setEdits((prev) => {
      const next = new Map(prev);
      const colEdits = new Map(next.get(c.key) ?? []);
      if (m === baseMark(s, c) && !c.isNew) colEdits.delete(s.regNo);
      else colEdits.set(s.regNo, m);
      if (colEdits.size) next.set(c.key, colEdits);
      else next.delete(c.key);
      return next;
    });
    setStatus(null);
  };
  const setColumn = (c: Col, m: Mark) => {
    setEdits((prev) => {
      const next = new Map(prev);
      next.set(c.key, new Map(students.filter((s) => baseMark(s, c) !== 'NA' || c.isNew).map((s) => [s.regNo, m])));
      return next;
    });
  };

  const totals = useMemo(() => {
    const out = new Map<string, { attended: number; held: number; pct: number | null }>();
    for (const s of students) {
      let attended = 0;
      let held = 0;
      for (const c of shownCols) {
        const m = markOf(s, c);
        if (m === 'NA') continue;
        held += c.hours;
        if (m === 'P' || m === 'OD' || (m === 'A' && excusedOn(c.date, excusals.get(s.regNo)))) attended += c.hours;
      }
      out.set(s.regNo, { attended, held, pct: held ? Math.round((attended / held) * 1000) / 10 : null });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [students, shownCols, edits, excusals]);

  const gridRows = students.filter((s) => {
    if (q && !`${s.regNo} ${s.name}`.toLowerCase().includes(q)) return false;
    if (onlyLow) {
      const t = totals.get(s.regNo);
      return t?.pct !== null && t?.pct !== undefined && t.pct < threshold;
    }
    return true;
  });
  const lowCount = students.filter((s) => {
    const p = totals.get(s.regNo)?.pct;
    return p !== null && p !== undefined && p < threshold;
  }).length;

  const save = async () => {
    if (!ctx?.subject || !ctx.cls || !subject) return;
    const changed = cols.filter((c) => edits.has(c.key) || c.isNew);
    const writes: (SessionWrite & { id: string })[] = [];
    for (const c of changed) {
      const any = Array.from(c.docs.values())[0];
      for (const t of ctx.cls.targets) {
        const existing = c.docs.get(t.branch);
        const mine = students.filter((s) => s.branch === t.branch);
        const marked = mine.map((s) => [s, markOf(s, c)] as const).filter(([, m]) => m !== 'NA');
        if (!marked.length && !existing) continue;

        const viewIds = new Set(mine.map((s) => s.regNo));

        const partial = marked.length < mine.length;
        const keepOnly = (existing?.onlyEnrollmentNumbers ?? []).filter((r) => !viewIds.has(r));
        const keepAbsent = (existing?.absentEnrollmentNumbers ?? []).filter((r) => !viewIds.has(r));
        const keepExcused = (existing?.excusedEnrollmentNumbers ?? []).filter((r) => !viewIds.has(r));
        const w: SessionWrite = {
          branch: t.branch,
          section: t.section,
          admissionYear: ctx.batch!.year,
          subjectCode: any?.subjectCode ?? ctx.subject.code,
          subjectName: any?.subjectName ?? ctx.subject.name,
          date: c.date,
          lecture: c.lecture,
          semester: any?.semester ?? ctx.semester!,
          specialization: existing?.specialization ?? any?.specialization ?? (ctx.specialization || null),
          absentEnrollmentNumbers: [...keepAbsent, ...marked.filter(([, m]) => m === 'A').map(([s]) => s.regNo)].sort(),
          excusedEnrollmentNumbers: [...keepExcused, ...marked.filter(([, m]) => m === 'OD').map(([s]) => s.regNo)].sort(),
          classSize: existing?.classSize ?? mine.length,
          hours: c.hours,
          kind: existing?.kind ?? (c.hours > 1 ? 'lab' : 'lecture'),
          ...(partial || keepOnly.length ? { onlyEnrollmentNumbers: [...keepOnly, ...marked.map(([st]) => st.regNo)].sort() } : {}),
          source: existing?.source ?? 'portal',
        };
        if (!partial && !keepOnly.length && existing?.onlyEnrollmentNumbers) w.onlyEnrollmentNumbers = [];
        writes.push({ ...w, id: existing?.id ?? sessionDocId(w) });
      }
    }
    if (!writes.length) return;
    if (!confirm(`Save changes to ${changed.length} class${changed.length === 1 ? '' : 'es'} of ${ctx.subject.code}?`)) return;
    setBusy('saving');
    try {
      await writeSessions(writes);
      setEdits(new Map());
      setNewCols([]);
      await reload();
      setStatus({ kind: 'ok', text: `Saved ${changed.length} class${changed.length === 1 ? '' : 'es'}. Students see the new percentages now.` });
    } catch (e: any) {
      setStatus({ kind: 'error', text: `Couldn’t save: ${e.message}. Your changes are still here — try again.` });
    } finally {
      setBusy('');
    }
  };

  const discard = () => {
    if (!confirm('Discard all unsaved changes?')) return;
    setEdits(new Map());
    setNewCols([]);
  };

  const addClass = () => {
    if (!isValidIso(addDate) || addDate > todayIso()) {
      setStatus({ kind: 'error', text: 'Pick a date that isn’t in the future.' });
      return;
    }
    const lecture = cols.filter((c) => c.date === addDate).length + 1;
    setNewCols((n) => [...n, { date: addDate, lecture, hours: addHours }]);
    setOpenCol(colKey(addDate, lecture));
    setStatus({ kind: 'ok', text: `Added ${prettyDate(addDate)}${lecture > 1 ? ` (class ${lecture})` : ''} — everyone is present; click cells to mark absences, then Save.` });
  };

  const removeClass = async (c: Col) => {
    if (c.isNew) {
      setNewCols((n) => n.filter((x) => colKey(x.date, x.lecture) !== c.key));
      setEdits((prev) => {
        const next = new Map(prev);
        next.delete(c.key);
        return next;
      });
      setOpenCol(null);
      return;
    }
    if (dirty) {
      setStatus({ kind: 'error', text: 'Save or discard your other changes before deleting a class.' });
      return;
    }
    if (!confirm(`Delete the class on ${prettyDate(c.date)}${c.lecture > 1 ? ` (class ${c.lecture})` : ''}? It stops counting for every student. This can’t be undone.`)) return;
    setBusy('deleting');
    try {
      await deleteSessions(Array.from(c.docs.values()).map((d) => d.id));
      setOpenCol(null);
      await reload();
      setStatus({ kind: 'ok', text: 'Class deleted.' });
    } catch (e: any) {
      setStatus({ kind: 'error', text: `Couldn’t delete: ${e.message}` });
    } finally {
      setBusy('');
    }
  };

  const removeShown = async () => {
    if (!ctx?.subject) return;
    const target = shownCols.filter((c) => !c.isNew);
    if (!target.length) return;
    if (dirty) {
      setStatus({ kind: 'error', text: 'Save or discard your changes first.' });
      return;
    }
    const range = from || to ? ` from ${from ? prettyDate(from) : 'the start'} to ${to ? prettyDate(to) : 'today'}` : ' (the whole semester)';
    const typed = prompt(
      `Delete ALL ${target.length} class${target.length === 1 ? '' : 'es'} of ${ctx.subject.code} for ${ctx.cls!.label}${range}?\n\n` +
        `Every student’s attendance for these classes is removed. This can’t be undone — download the register first if you might need it.\n\n` +
        `Type ${ctx.subject.code} to confirm:`,
    );
    if (typed === null) return;
    if (typed.trim().toUpperCase() !== ctx.subject.code.toUpperCase()) {
      setStatus({ kind: 'error', text: 'The subject code didn’t match — nothing was deleted.' });
      return;
    }
    setBusy('deleting');
    try {
      await deleteSessions(target.flatMap((c) => Array.from(c.docs.values()).map((d) => d.id)));
      setOpenCol(null);
      await reload();
      setStatus({ kind: 'ok', text: `Deleted ${target.length} class${target.length === 1 ? '' : 'es'} of ${ctx.subject.code}.` });
    } catch (e: any) {
      setStatus({ kind: 'error', text: `Couldn’t delete: ${e.message}` });
    } finally {
      setBusy('');
    }
  };

  const download = async () => {
    if (!ctx) return;
    if (dirty && !confirm('You have unsaved changes — the download has only what’s saved. Continue?')) return;
    setBusy('downloading');
    try {
      await downloadSemesterRegister(ctx, ctx.subject);
    } catch (e: any) {
      setStatus({ kind: 'error', text: `Couldn’t build the download: ${e.message}` });
    } finally {
      setBusy('');
    }
  };

  const withData = data && !ctx?.subject ? data.subjects.filter((s) => s.sessions.length) : [];
  const matrix = useMemo(() => {
    if (!data || ctx?.subject) return [];
    return students.map((s) => {
      let attended = 0;
      let held = 0;
      const per = withData.map((subj) => {
        const own = subj.sessions.filter((d) => d.branch === s.branch && inRange(d.date, from, to));
        const r = studentRecord(s, own, excusals.get(s.regNo));
        attended += r.attended;
        held += r.total;
        return r.total ? { pct: Math.round((r.attended / r.total) * 1000) / 10, a: r.attended, t: r.total } : null;
      });
      return { s, per, overall: held ? Math.round((attended / held) * 1000) / 10 : null, attended, held };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, students, from, to, excusals]);
  const matrixRows = matrix.filter((r) => {
    if (q && !`${r.s.regNo} ${r.s.name}`.toLowerCase().includes(q)) return false;
    if (onlyLow) return r.per.some((p) => p && p.pct < threshold);
    return true;
  });
  const matrixLow = matrix.filter((r) => r.per.some((p) => p && p.pct < threshold)).length;

  const daySessions = useMemo(() => {
    if (!data || ctx?.subject) return [];
    const byKey = new Map<string, { code: string; name: string; lecture: number; docs: Doc[] }>();
    for (const subj of data.subjects) {
      for (const d of subj.sessions as Doc[]) {
        if (d.date !== dayView) continue;
        const k = `${subj.code}#${d.lecture ?? 1}`;
        if (!byKey.has(k)) byKey.set(k, { code: subj.code, name: subj.name, lecture: d.lecture ?? 1, docs: [] });
        byKey.get(k)!.docs.push(d);
      }
    }
    return Array.from(byKey.values()).sort((a, b) => a.code.localeCompare(b.code) || a.lecture - b.lecture);
  }, [data, dayView, ctx?.subject]);
  const nameOf = (r: string) => students.find((s) => s.regNo === r)?.name ?? r;

  const opened = cols.find((c) => c.key === openCol) ?? null;
  const pctClass = (p: number | null | undefined) => (p === null || p === undefined ? '' : p < threshold ? 'att-bad' : p < threshold + 5 ? 'att-mid' : 'att-good');

  return (
    <div className="card att-card att-card-wide">
      <h1 style={{ fontSize: '1.5rem' }}>Attendance register</h1>
      <p className="res-hint">
        Pick a subject to see and edit its full register, or leave “All subjects” for every student’s % in every subject and
        a day-by-day view. Percentages are always classes attended ÷ classes actually held.
      </p>

      <AttendanceClassPicker subjectMode="optional" onChange={setCtx} />

      {error && <p className="notice notice-error">{error}</p>}
      {ctx && !data && !error && <p className="res-hint">Loading…</p>}

      {ctx && data && (
        <>
          <div className="att-filters">
            <input className="att-search" placeholder="Find a student…" value={search} onChange={(e) => setSearch(e.target.value)} />
            <label className="att-check">
              <input type="checkbox" checked={onlyLow} onChange={(e) => setOnlyLow(e.target.checked)} />
              Only below
              <input
                type="number"
                min={1}
                max={100}
                value={threshold}
                onChange={(e) => setThreshold(Math.min(100, Math.max(1, Number(e.target.value) || LOW_ATTENDANCE)))}
                className="att-num"
              />
              %
            </label>
            <span className="att-count att-a">{ctx.subject ? lowCount : matrixLow} below {threshold}%</span>
            <span style={{ flex: 1 }} />
            <label className="att-check">
              From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="att-date" />
            </label>
            <label className="att-check">
              to <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="att-date" />
            </label>
            {(from || to) && (
              <button type="button" className="button-secondary" onClick={() => { setFrom(''); setTo(''); }}>All dates</button>
            )}
          </div>

          {ctx.subject && (
            <>
              <div className="att-toolbar">
                <strong>{shownCols.length}</strong>
                <span className="att-muted">
                  classes held{from || to ? ' in this range' : ''}
                  {shownCols.some((c) => c.hours > 1) ? ` · ${shownCols.reduce((a, c) => a + c.hours, 0)} hours (labs count by hours)` : ''}
                </span>
                <span style={{ flex: 1 }} />
                <input type="date" value={addDate} max={todayIso()} onChange={(e) => setAddDate(e.target.value)} className="att-date" />
                <select value={addHours} onChange={(e) => setAddHours(Number(e.target.value))} className="att-date">
                  <option value={1}>Lecture · 1 hr</option>
                  <option value={2}>Lab · 2 hrs</option>
                  <option value={3}>Lab · 3 hrs</option>
                </select>
                <button type="button" className="button-secondary" onClick={addClass}>+ Add class</button>
                <button type="button" className="button-secondary" onClick={download} disabled={!!busy || !cols.length}>
                  {busy === 'downloading' ? 'Preparing…' : 'Download (.xlsx)'}
                </button>
                <button
                  type="button"
                  className="button-secondary att-danger"
                  onClick={removeShown}
                  disabled={!!busy || !shownCols.some((c) => !c.isNew)}
                  title="Delete every class shown (use From/To to pick a range)"
                >
                  {busy === 'deleting' ? 'Deleting…' : from || to ? 'Delete classes in range' : 'Delete all classes'}
                </button>
              </div>
              <p className="res-hint">
                Click a cell to cycle P → A → OD → — (not in this class, e.g. the other lab batch). Click a date to see that day and delete it. “—” means not this student’s class.
                To fix many marks at once: Download, edit in Excel, then Upload — it updates these same classes.
              </p>

              {!cols.length ? (
                <p className="notice">No classes recorded for {ctx.subject.code} yet. Add one above, mark it, or upload an old register.</p>
              ) : (
                <div className="att-grid-wrap">
                  <table className="att-grid">
                    <thead>
                      <tr>
                        <th className="g-sticky g-name">Student</th>
                        {shownCols.map((c) => (
                          <th
                            key={c.key}
                            className={`g-col ${openCol === c.key ? 'on' : ''} ${edits.has(c.key) || c.isNew ? 'changed' : ''}`}
                            onClick={() => setOpenCol(openCol === c.key ? null : c.key)}
                            title="Open this day"
                          >
                            <span>{Number(c.date.slice(8))}</span>
                            <small>{new Date(c.date + 'T00:00').toLocaleDateString('en-IN', { month: 'short' })}{c.lecture > 1 ? ` ·${c.lecture}` : ''}</small>
                            {c.hours > 1 && <em className="g-lab">{c.hours}h</em>}
                          </th>
                        ))}
                        <th className="g-total">{shownCols.some((c) => c.hours > 1) ? 'Hours' : 'Attended'}</th>
                        <th className="g-total">%</th>
                      </tr>
                    </thead>
                    <tbody>
                      {gridRows.map((s) => {
                        const t = totals.get(s.regNo)!;
                        return (
                          <tr key={s.regNo}>
                            <td className="g-sticky g-name">
                              <strong>{s.name}</strong>
                              <small>{s.regNo}</small>
                            </td>
                            {shownCols.map((c) => {
                              const m = markOf(s, c);
                              const edited = edits.get(c.key)?.has(s.regNo);
                              const exc = m === 'A' && excusedOn(c.date, excusals.get(s.regNo));
                              return (
                                <td
                                  key={c.key}
                                  className={`g-cell m-${m} ${edited ? 'edited' : ''} ${openCol === c.key ? 'on' : ''}`}
                                  onClick={() => setCell(s, c, NEXT[m])}
                                  title={exc ? 'Absent, but excused for an approved event — counts as attended' : m === 'NA' ? 'Not this student’s class — click to include' : ''}
                                >
                                  {m === 'NA' ? '—' : m}
                                  {exc && <i>•</i>}
                                </td>
                              );
                            })}
                            <td className="g-total">{t.attended}/{t.held}</td>
                            <td className={`g-total ${pctClass(t.pct)}`}>{t.pct === null ? '—' : `${t.pct}%`}</td>
                          </tr>
                        );
                      })}
                      {!gridRows.length && (
                        <tr>
                          <td className="g-sticky g-name att-muted" colSpan={1}>No students match.</td>
                        </tr>
                      )}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td className="g-sticky g-name att-muted">Present</td>
                        {shownCols.map((c) => (
                          <td key={c.key} className="g-foot">
                            {students.filter((s) => ['P', 'OD'].includes(markOf(s, c))).length}
                          </td>
                        ))}
                        <td className="g-total" />
                        <td className="g-total" />
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}

              {opened && (
                <div className="att-day">
                  <div className="att-row" style={{ alignItems: 'center', marginTop: 0 }}>
                    <h3 style={{ margin: 0, flex: 1, fontSize: '1rem' }}>
                      {prettyDate(opened.date)} {opened.date.slice(0, 4)}
                      {opened.lecture > 1 ? ` · class ${opened.lecture}` : ''}
                      {opened.isNew ? ' · new, not saved' : ''}
                    </h3>
                    <button type="button" className="button-secondary" onClick={() => setColumn(opened, 'P')}>All present</button>
                    <button type="button" className="button-secondary att-danger" onClick={() => removeClass(opened)} disabled={!!busy}>
                      {opened.isNew ? 'Remove' : 'Delete class'}
                    </button>
                    <button type="button" className="button-secondary" onClick={() => setOpenCol(null)}>Close</button>
                  </div>
                  {(() => {
                    const ms = students.map((s) => [s, markOf(s, opened)] as const);
                    const abs = ms.filter(([, m]) => m === 'A');
                    const od = ms.filter(([, m]) => m === 'OD');
                    const pres = ms.filter(([, m]) => m === 'P');
                    const by = Array.from(opened.docs.values())[0]?.markedByName;
                    return (
                      <>
                        <p className="res-hint">
                          {pres.length} present · {abs.length} absent{od.length ? ` · ${od.length} on duty` : ''}
                          {by ? ` · marked by ${by}` : ''}
                        </p>
                        {abs.length > 0 && (
                          <p className="att-namelist"><b>Absent:</b> {abs.map(([s]) => `${s.name} (${s.regNo.slice(-3)})`).join(', ')}</p>
                        )}
                        {od.length > 0 && (
                          <p className="att-namelist"><b>On duty:</b> {od.map(([s]) => `${s.name} (${s.regNo.slice(-3)})`).join(', ')}</p>
                        )}
                      </>
                    );
                  })()}
                </div>
              )}

              {dirty && (
                <div className="att-savebar">
                  <span>
                    Unsaved changes in {new Set([...edits.keys(), ...newCols.map((n) => colKey(n.date, n.lecture))]).size} class
                    {new Set([...edits.keys(), ...newCols.map((n) => colKey(n.date, n.lecture))]).size === 1 ? '' : 'es'}
                  </span>
                  <span style={{ flex: 1 }} />
                  <button type="button" className="button-secondary" onClick={discard} disabled={!!busy}>Discard</button>
                  <button type="button" onClick={save} disabled={!!busy}>{busy === 'saving' ? 'Saving…' : 'Save changes'}</button>
                </div>
              )}
            </>
          )}

          {!ctx.subject && (
            <>
              {!withData.length ? (
                <p className="notice">No attendance recorded for this class and semester yet.</p>
              ) : (
                <div className="att-grid-wrap">
                  <table className="att-grid att-matrix">
                    <thead>
                      <tr>
                        <th className="g-sticky g-name">Student</th>
                        {withData.map((s) => {
                          const held = new Set(s.sessions.filter((d) => inRange(d.date, from, to)).map((d) => colKey(d.date, d.lecture ?? 1))).size;
                          return (
                            <th key={s.code} className="g-subj" title={s.name}>
                              {s.code}
                              <small>{held} held</small>
                            </th>
                          );
                        })}
                        <th className="g-total">Overall</th>
                      </tr>
                    </thead>
                    <tbody>
                      {matrixRows.map((r) => (
                        <tr key={r.s.regNo}>
                          <td className="g-sticky g-name">
                            <strong>{r.s.name}</strong>
                            <small>{r.s.regNo}</small>
                          </td>
                          {r.per.map((p, i) => (
                            <td key={withData[i].code} className={`g-pct ${pctClass(p?.pct)}`} title={p ? `${p.a} of ${p.t} attended` : 'No classes for this student'}>
                              {p ? `${p.pct}%` : '—'}
                              {p && <small>{p.a}/{p.t}</small>}
                            </td>
                          ))}
                          <td className={`g-total ${pctClass(r.overall)}`}>{r.overall === null ? '—' : `${r.overall}%`}</td>
                        </tr>
                      ))}
                      {!matrixRows.length && (
                        <tr>
                          <td className="g-sticky g-name att-muted">No students match.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="att-day">
                <div className="att-row" style={{ alignItems: 'center', marginTop: 0 }}>
                  <h3 style={{ margin: 0, flex: 1, fontSize: '1rem' }}>Attendance on a day</h3>
                  <input type="date" value={dayView} max={todayIso()} onChange={(e) => setDayView(e.target.value)} className="att-date" />
                </div>
                {!daySessions.length ? (
                  <p className="res-hint">No classes recorded on {isValidIso(dayView) ? prettyDate(dayView) : 'that day'}.</p>
                ) : (
                  <table className="att-table">
                    <thead>
                      <tr>
                        <th>Subject</th>
                        <th>Present</th>
                        <th>Absent</th>
                        <th>Marked by</th>
                      </tr>
                    </thead>
                    <tbody>
                      {daySessions.map((d) => {
                        const absent = d.docs.flatMap((x) => x.absentEnrollmentNumbers);
                        const size = d.docs.reduce((a, x) => a + (x.classSize ?? 0), 0) || students.length;
                        return (
                          <Fragment key={`${d.code}#${d.lecture}`}>
                            <tr>
                              <td>
                                <strong>{d.code}</strong> <span className="att-muted">{d.name}{d.lecture > 1 ? ` · class ${d.lecture}` : ''}</span>
                              </td>
                              <td>{size - absent.length}</td>
                              <td className={absent.length ? 'att-bad' : ''}>{absent.length}</td>
                              <td className="att-muted">{d.docs[0]?.markedByName ?? '—'}</td>
                            </tr>
                            {absent.length > 0 && (
                              <tr>
                                <td colSpan={4} className="att-namelist">{absent.map((r) => `${nameOf(r)} (${r.slice(-3)})`).join(', ')}</td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </>
          )}

          {status && <p className={`notice ${status.kind === 'ok' ? 'notice-ok' : 'notice-error'}`}>{status.text}</p>}
        </>
      )}
    </div>
  );
}
