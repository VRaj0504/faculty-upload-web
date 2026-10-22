import { useCallback, useEffect, useMemo, useState } from 'react';
import AttendanceClassPicker, { type PickerState } from './AttendanceClassPicker';
import {
  dateWarnings,
  isValidIso,
  matchReg,
  pickBatch,
  prettyDate,
  semesterWindow,
  todayIso,
  type SessionDoc,
} from './attendanceCore';
import { deleteSessions, loadClassSessions, splitByBranch, writeSessions } from './attendanceData';
import { downloadSemesterRegister } from './AttendanceExport';

type Mark = 'P' | 'A' | 'OD';
type Held = SessionDoc & { id: string };

function MarkAttendance() {
  const [ctx, setCtx] = useState<PickerState | null>(null);
  const [date, setDate] = useState(todayIso());
  const [lecture, setLecture] = useState(1);

  const [held, setHeld] = useState<Held[] | null>(null);
  const [marks, setMarks] = useState<Map<string, Mark>>(new Map());
  const [dirty, setDirty] = useState(false);
  const [rollInput, setRollInput] = useState('');
  const [rollFeedback, setRollFeedback] = useState('');
  const [busy, setBusy] = useState<'' | 'saving' | 'deleting' | 'downloading'>('');
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [filter, setFilter] = useState('');

  const classStudents = ctx?.students ?? [];
  const classKey = ctx ? `${ctx.batch!.key}|${ctx.cls!.key}|${ctx.subject?.code}|${ctx.specialization}|${ctx.semester}` : '';

  const [kind, setKind] = useState<'lecture' | 'lab'>('lecture');
  const [hours, setHours] = useState(1);
  const [batchMode, setBatchMode] = useState<string>('all');
  const [rangeText, setRangeText] = useState('');
  const [savedOnly, setSavedOnly] = useState<Set<string> | null>(null);
  useEffect(() => {
    if (!ctx?.subject) return;
    let pref: { kind?: 'lecture' | 'lab'; hours?: number; batch?: string } = {};
    try {
      pref = JSON.parse(localStorage.getItem(`att-lab:${classKey}`) ?? '{}');
    } catch {

    }
    const looksLab = /\b(lab|laboratory|workshop|practical)\b/i.test(ctx.subject.name);
    setKind(pref.kind ?? (looksLab ? 'lab' : 'lecture'));
    setHours(pref.hours ?? (looksLab ? 2 : 1));
    setBatchMode(pref.batch ?? 'all');
    setRangeText(pref.batch?.startsWith('r:') ? pref.batch.slice(2) : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classKey]);
  const rememberLab = (next: { kind?: 'lecture' | 'lab'; hours?: number; batch?: string }) => {
    try {
      const cur = JSON.parse(localStorage.getItem(`att-lab:${classKey}`) ?? '{}');
      localStorage.setItem(`att-lab:${classKey}`, JSON.stringify({ ...cur, ...next }));
    } catch {

    }
  };

  const students = useMemo(() => {
    if (batchMode === 'saved' && savedOnly) return classStudents.filter((s) => savedOnly.has(s.regNo));
    if (batchMode === 'all' || batchMode === 'saved') return classStudents;
    return pickBatch(classStudents, batchMode);
  }, [classStudents, batchMode, savedOnly]);
  const partOfClass = students.length < classStudents.length;
  const batchName =
    batchMode === 'h1' ? 'Batch 1 (first half)' : batchMode === 'h2' ? 'Batch 2 (second half)' : batchMode.startsWith('r:') ? `Roll ${batchMode.slice(2)}` : batchMode === 'saved' ? 'Saved batch' : 'Whole class';

  const reloadHeld = useCallback(async () => {
    if (!ctx?.cls || !ctx.batch || !ctx.subject) return;
    setHeld(await loadClassSessions(ctx.cls, ctx.batch.year, ctx.subject.code));
  }, [ctx]);

  useEffect(() => {
    setHeld(null);
    setStatus(null);
    setFilter('');
    if (!ctx?.subject) return;
    reloadHeld().catch((e) => setStatus({ kind: 'error', text: `Couldn’t load past classes: ${e.message}` }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classKey]);

  const existing = useMemo(
    () => (held ?? []).filter((h) => h.date === date && (h.lecture ?? 1) === lecture),
    [held, date, lecture],
  );

  useEffect(() => {
    const first = existing[0];
    if (first) {
      if (first.hours) setHours(first.hours);
      if (first.kind) setKind(first.kind);
      else if ((first.hours ?? 1) > 1) setKind('lab');
      if (first.onlyEnrollmentNumbers?.length) {
        setSavedOnly(new Set(existing.flatMap((d) => d.onlyEnrollmentNumbers ?? [])));
        setBatchMode('saved');
      } else if (batchMode === 'saved') setBatchMode('all');
    } else {
      setSavedOnly(null);
      if (batchMode === 'saved') setBatchMode('all');
    }
    const m = new Map<string, Mark>();
    for (const d of existing) {
      d.absentEnrollmentNumbers.forEach((r) => m.set(r, 'A'));
      d.excusedEnrollmentNumbers?.forEach((r) => m.set(r, 'OD'));
    }
    setMarks(m);
    setDirty(false);
    setRollInput(
      Array.from(m)
        .filter(([, v]) => v === 'A')
        .map(([r]) => r)
        .sort()
        .join(', '),
    );
    setRollFeedback('');
  }, [existing]);

  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const absentText = (m: Map<string, Mark>) =>
    Array.from(m)
      .filter(([, v]) => v === 'A')
      .map(([r]) => r)
      .sort()
      .join(', ');
  const setMark = (r: string, v: Mark) => {
    const next = new Map(marks);
    if (v === 'P') next.delete(r);
    else next.set(r, v);
    setMarks(next);
    setRollInput(absentText(next));
    setDirty(true);
    setRollFeedback('');
  };
  const setAll = (v: Mark) => {
    const next = new Map<string, Mark>();
    if (v !== 'P') students.forEach((s) => next.set(s.regNo, v));
    setMarks(next);
    setRollInput(absentText(next));
    setDirty(true);
  };

  const counts = useMemo(() => {
    let A = 0;
    let OD = 0;
    for (const s of students) {
      const m = marks.get(s.regNo);
      if (m === 'A') A++;
      else if (m === 'OD') OD++;
    }
    return { A, OD, P: students.length - A - OD };
  }, [marks, students]);

  const applyRolls = () => {
    if (!ctx) return;
    const tokens = rollInput.split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean);
    const next = new Map<string, Mark>(Array.from(marks).filter(([, v]) => v === 'OD'));
    const problems: string[] = [];
    for (const t of tokens) {
      const m = matchReg(t, students, ctx.roster);
      if (m.kind === 'ok') next.set(m.student.regNo, 'A');
      else if (m.kind === 'ambiguous') problems.push(`${t} (matches more than one student)`);
      else if (m.kind === 'elsewhere') problems.push(`${t} (${m.student.name} is in ${m.student.section ?? m.student.branch}, not this class)`);
      else problems.push(`${t} (not found)`);
    }
    setMarks(next);
    setDirty(true);
    const absentNow = Array.from(next.values()).filter((v) => v === 'A').length;
    setRollFeedback(
      problems.length
        ? `Marked ${absentNow} absent. Couldn’t use: ${problems.join('; ')}.`
        : `Marked ${absentNow} absent. Everyone else is present.`,
    );
  };

  const dateProblem = !isValidIso(date) ? 'Pick a valid date.' : date > todayIso() ? 'That date is in the future.' : '';
  const warnings =
    ctx && !dateProblem
      ? dateWarnings(date, { holidays: ctx.holidays, window: semesterWindow(ctx.batch!.year, ctx.semester!) })
      : [];
  const lecturesThatDay = (held ?? []).filter((h) => h.date === date).map((h) => h.lecture ?? 1);

  const otherBatchInSlot =
    existing.length > 0 &&
    existing.some((d) => d.onlyEnrollmentNumbers?.length) &&
    !students.some((s) => existing.some((d) => d.onlyEnrollmentNumbers?.includes(s.regNo)));
  const saveLecture = otherBatchInSlot ? Math.max(...lecturesThatDay) + 1 : lecture;

  const save = async () => {
    if (!ctx?.subject || !ctx.cls || dateProblem || !students.length) return;
    const lecture = saveLecture;
    const msg =
      (otherBatchInSlot ? `Another batch is already saved as class ${existing[0].lecture ?? 1} that day — this batch will be saved as class ${lecture}.\n\n` : '') +
      `Save ${ctx.subject.code} for ${ctx.cls.label} on ${prettyDate(date)}${lecture > 1 ? ` (class ${lecture} of the day)` : ''}?\n\n` +
      (kind === 'lab' ? `Lab / workshop · ${hours} hour${hours > 1 ? 's' : ''} (counts as ${hours})${partOfClass ? ` · ${batchName}, ${students.length} students` : ''}\n` : '') +
      `${counts.P} present · ${counts.A} absent${counts.OD ? ` · ${counts.OD} on duty` : ''}` +
      (warnings.length ? `\n\nNote: this date is a ${warnings.join(', ')}.` : '') +
      (existing.length && !otherBatchInSlot ? '\n\nThis replaces the attendance already saved for this class.' : '');
    if (!confirm(msg)) return;
    setBusy('saving');
    setStatus(null);
    try {
      const absent = students.filter((s) => marks.get(s.regNo) === 'A');
      const excused = students.filter((s) => marks.get(s.regNo) === 'OD');
      const docs = splitByBranch(
        ctx.cls,
        {
          admissionYear: ctx.batch!.year,
          subjectCode: ctx.subject.code,
          subjectName: ctx.subject.name,
          date,
          lecture,
          semester: ctx.semester!,
          specialization: ctx.specialization || null,
          hours: kind === 'lab' ? hours : 1,
          kind,
          ...(partOfClass ? { batchLabel: batchName } : {}),
          source: 'portal',
        },
        absent,
        excused,
        students,
        partOfClass,
      );
      await writeSessions(docs);

      const stale = otherBatchInSlot ? [] : existing.map((e) => e.id).filter((id) => !docs.some((d) => d.id === id));
      if (stale.length) await deleteSessions(stale);
      if (lecture !== saveLecture || otherBatchInSlot) setLecture(lecture);
      setDirty(false);
      setStatus({ kind: 'ok', text: `Saved — ${counts.P} present, ${counts.A} absent${counts.OD ? `, ${counts.OD} on duty` : ''}.` });
      await reloadHeld();
    } catch (e: any) {
      setStatus({ kind: 'error', text: `Couldn’t save: ${e.message}. Your marks are still here — try again.` });
    } finally {
      setBusy('');
    }
  };

  const remove = async () => {
    if (!existing.length) return;
    if (!confirm(`Delete the attendance for ${prettyDate(date)}${lecture > 1 ? ` (class ${lecture})` : ''}? Use this when the class didn’t actually happen. It can’t be undone.`)) return;
    setBusy('deleting');
    try {
      await deleteSessions(existing.map((e) => e.id));
      setStatus({ kind: 'ok', text: 'Deleted. This class no longer counts in anyone’s percentage.' });
      await reloadHeld();
    } catch (e: any) {
      setStatus({ kind: 'error', text: `Couldn’t delete: ${e.message}` });
    } finally {
      setBusy('');
    }
  };

  const download = async () => {
    if (!ctx) return;
    setBusy('downloading');
    try {
      await downloadSemesterRegister(ctx, ctx.subject);
    } catch (e: any) {
      setStatus({ kind: 'error', text: `Couldn’t build the download: ${e.message}` });
    } finally {
      setBusy('');
    }
  };

  const confirmLeave = () => !dirty || confirm('You have unsaved attendance. Discard it?');

  const heldDays = useMemo(() => {
    const m = new Map<string, { date: string; lecture: number; absent: number }>();
    for (const h of held ?? []) {
      const k = `${h.date}#${h.lecture ?? 1}`;
      const prev = m.get(k);
      m.set(k, { date: h.date, lecture: h.lecture ?? 1, absent: (prev?.absent ?? 0) + h.absentEnrollmentNumbers.length });
    }
    return Array.from(m.values()).sort((a, b) => b.date.localeCompare(a.date) || b.lecture - a.lecture);
  }, [held]);

  const q = filter.trim().toLowerCase();
  const shown = q ? students.filter((s) => `${s.regNo} ${s.name}`.toLowerCase().includes(q)) : students;

  return (
    <div className="card att-card">
      <h1 style={{ fontSize: '1.5rem' }}>Mark attendance</h1>
      <p className="res-hint">
        Everyone starts present — mark only who’s absent. Students see their percentage in the app as soon as you save.
      </p>

      <AttendanceClassPicker subjectMode="required" onChange={setCtx} />

      {ctx && (
        <>
          <div className="att-row">
            <div className="att-field att-narrow">
              <label>Date</label>
              <input
                type="date"
                value={date}
                max={todayIso()}
                onChange={(e) => {
                  if (!confirmLeave()) return;
                  setDate(e.target.value);
                  setLecture(1);
                }}
              />
            </div>
            <div className="att-field att-narrow">
              <label>Which class that day</label>
              <select
                value={lecture}
                onChange={(e) => {
                  if (!confirmLeave()) return;
                  setLecture(Number(e.target.value));
                }}
              >
                {[1, 2, 3, 4].map((n) => (
                  <option key={n} value={n}>
                    {['1st', '2nd', '3rd', '4th'][n - 1]} class{lecturesThatDay.includes(n) ? ' · saved' : ''}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="att-row">
            <div className="att-field att-narrow">
              <label>Class type</label>
              <select
                value={kind === 'lab' ? `lab${hours}` : 'lecture'}
                onChange={(e) => {
                  const v = e.target.value;
                  const k = v === 'lecture' ? 'lecture' : 'lab';
                  const h = v === 'lecture' ? 1 : Number(v.slice(3));
                  setKind(k);
                  setHours(h);
                  setDirty(true);
                  rememberLab({ kind: k, hours: h });
                }}
              >
                <option value="lecture">Lecture (1 hour)</option>
                <option value="lab2">Lab / workshop — 2 hours</option>
                <option value="lab3">Lab / workshop — 3 hours</option>
                <option value="lab1">Lab / tutorial — 1 hour</option>
              </select>
            </div>
            <div className="att-field">
              <label>Who attends</label>
              <select
                value={batchMode.startsWith('r:') ? 'r' : batchMode}
                onChange={(e) => {
                  const v = e.target.value === 'r' ? `r:${rangeText}` : e.target.value;
                  setBatchMode(v);
                  setDirty(true);
                  if (v !== 'saved') rememberLab({ batch: v });
                }}
              >
                <option value="all">Whole class ({classStudents.length})</option>
                <option value="h1">Batch 1 — first half ({Math.ceil(classStudents.length / 2)})</option>
                <option value="h2">Batch 2 — second half ({Math.floor(classStudents.length / 2)})</option>
                <option value="r">Roll numbers… (custom batch)</option>
                {savedOnly && <option value="saved">As saved ({savedOnly.size} students)</option>}
              </select>
            </div>
          </div>
          {batchMode.startsWith('r:') && (
            <div className="att-row">
              <input
                style={{ flex: 1 }}
                placeholder="e.g. 1-35  or  101-140, 145  (last digits of the reg. no.)"
                value={rangeText}
                onChange={(e) => {
                  setRangeText(e.target.value);
                  setBatchMode(`r:${e.target.value}`);
                  rememberLab({ batch: `r:${e.target.value}` });
                }}
              />
            </div>
          )}
          <p className="res-hint">
            {kind === 'lab'
              ? `A ${hours}-hour lab counts as ${hours} classes in the percentage (hours attended ÷ hours held).`
              : 'Two lectures of this subject on one day? Save the second as “2nd class”.'}{' '}
            {partOfClass
              ? `Only these ${students.length} students are counted for this class — the rest of the class isn’t marked absent.`
              : kind === 'lab'
                ? 'Lab split into batches? Pick the batch above so the other half isn’t marked absent.'
                : ''}
          </p>

          {dateProblem && <p className="notice notice-error">{dateProblem}</p>}
          {!dateProblem && warnings.length > 0 && (
            <p className="notice att-warn">
              Heads up: {prettyDate(date)} is a {warnings.join(', ')}. You can still save if the class happened.
            </p>
          )}
          {!dateProblem && existing.length > 0 && !otherBatchInSlot && (
            <p className="notice notice-ok">
              Already saved{existing[0].markedByName ? ` by ${existing[0].markedByName}` : ''} — you’re editing that record.
            </p>
          )}
          {!dateProblem && otherBatchInSlot && (
            <p className="notice att-warn">
              {existing[0].batchLabel ?? 'Another batch'} is already saved in this slot. This batch will be saved as class {saveLecture} of
              the day, so neither overwrites the other.
            </p>
          )}
          {students.length === 0 && (
            <p className="notice notice-error">No students in this class{ctx.specialization ? ` for ${ctx.specialization}` : ''}.</p>
          )}
          {held === null && !status && <p className="res-hint">Loading…</p>}

          {!dateProblem && students.length > 0 && held !== null && (
            <>
              <div className="att-rolls">
                <label>Type absentees (fastest)</label>
                <div className="att-row" style={{ marginTop: 0 }}>
                  <textarea
                    value={rollInput}
                    onChange={(e) => setRollInput(e.target.value)}
                    placeholder="e.g. 114, 117, 132 — full numbers or last digits"
                    rows={2}
                    style={{ flex: 1 }}
                  />
                  <button type="button" onClick={applyRolls}>Apply</button>
                </div>
                {rollFeedback && <p className="res-hint">{rollFeedback}</p>}
              </div>

              <div className="att-toolbar">
                <span className="att-count att-p">{counts.P} present</span>
                <span className="att-count att-a">{counts.A} absent</span>
                {counts.OD > 0 && <span className="att-count att-od">{counts.OD} on duty</span>}
                <span style={{ flex: 1 }} />
                <input className="att-search" placeholder="Find a student…" value={filter} onChange={(e) => setFilter(e.target.value)} />
                <button type="button" className="button-secondary" onClick={() => setAll('P')}>All present</button>
                <button type="button" className="button-secondary" onClick={() => setAll('A')}>All absent</button>
              </div>

              <div className="att-list">
                {shown.map((s, i) => {
                  const m = marks.get(s.regNo) ?? 'P';
                  return (
                    <div key={s.regNo} className={`att-student att-is-${m}`}>
                      <span className="att-idx">{i + 1}</span>
                      <button type="button" className="att-name" onClick={() => setMark(s.regNo, m === 'A' ? 'P' : 'A')}>
                        <strong>{s.name}</strong>
                        <small>
                          {s.regNo}
                          {ctx.cls!.targets.length > 1 ? ` · ${s.branch}` : ''}
                        </small>
                      </button>
                      <div className="att-seg" role="radiogroup" aria-label={`${s.name} attendance`}>
                        {(['P', 'A', 'OD'] as Mark[]).map((v) => (
                          <button
                            key={v}
                            type="button"
                            role="radio"
                            aria-checked={m === v}
                            className={m === v ? 'on' : ''}
                            title={v === 'P' ? 'Present' : v === 'A' ? 'Absent' : 'On duty / leave — counts as attended'}
                            onClick={() => setMark(s.regNo, v)}
                          >
                            {v}
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
                {!shown.length && <p className="res-hint" style={{ padding: '0.8rem' }}>No student matches “{filter}”.</p>}
              </div>

              <div className="att-actions">
                <button type="button" onClick={save} disabled={!!busy} style={{ flex: 1 }}>
                  {busy === 'saving' ? 'Saving…' : `${existing.length ? 'Update' : 'Save'} — ${counts.P} present, ${counts.A} absent`}
                </button>
                {existing.length > 0 && (
                  <button type="button" className="button-secondary att-danger" onClick={remove} disabled={!!busy}>
                    {busy === 'deleting' ? 'Deleting…' : 'Delete this class'}
                  </button>
                )}
              </div>
              {dirty && <p className="res-hint">Unsaved changes.</p>}
            </>
          )}

          {status && <p className={`notice ${status.kind === 'ok' ? 'notice-ok' : 'notice-error'}`}>{status.text}</p>}

          {held !== null && (
            <div className="att-held">
              <div className="att-row" style={{ alignItems: 'center' }}>
                <h3 style={{ margin: 0, flex: 1, fontSize: '1rem' }}>
                  {heldDays.length} class{heldDays.length === 1 ? '' : 'es'} of {ctx.subject!.code} recorded
                </h3>
                <button type="button" className="button-secondary" onClick={download} disabled={!!busy || !heldDays.length}>
                  {busy === 'downloading' ? 'Preparing…' : 'Download register (.xlsx)'}
                </button>
              </div>
              {heldDays.length > 0 ? (
                <div className="att-chips">
                  {heldDays.map((h) => (
                    <button
                      key={`${h.date}#${h.lecture}`}
                      type="button"
                      className={`att-chip ${h.date === date && h.lecture === lecture ? 'on' : ''}`}
                      onClick={() => {
                        if (!confirmLeave()) return;
                        setDate(h.date);
                        setLecture(h.lecture);
                      }}
                      title="Open to edit"
                    >
                      {prettyDate(h.date)}
                      {h.lecture > 1 ? ` · ${h.lecture}` : ''}
                      <small>{h.absent} absent</small>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="res-hint">Nothing recorded yet for this subject.</p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default MarkAttendance;
