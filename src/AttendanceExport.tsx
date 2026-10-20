import { useEffect, useState } from 'react';
import AttendanceClassPicker, { type PickerState } from './AttendanceClassPicker';
import {
  LOW_ATTENDANCE,
  batchLabel,
  buildSemesterWorkbook,
  normCode,
  semesterWindow,
  studentRecord,
  type ExportSubject,
  type SessionDoc,
} from './attendanceCore';
import { loadApprovedExcusals, loadClassSessions, loadSubjects, type SubjectOption } from './attendanceData';
import { downloadXlsx } from './xlsxTemplates';

export type Prepared = {
  subjects: ExportSubject[];
  title: string;
  filename: string;
  excusals: Awaited<ReturnType<typeof loadApprovedExcusals>>;
};

// Collects everything for one class + semester (+ optionally one subject).
// A session belongs to the semester if it was saved with that semester, or
// (older records without one) if its subject is in that semester's
// curriculum, or its date falls inside the semester.
export async function prepare(ctx: PickerState, only: SubjectOption | null): Promise<Prepared> {
  const cls = ctx.cls!;
  const batch = ctx.batch!;
  const sem = ctx.semester!;
  const [all, curriculum] = await Promise.all([
    loadClassSessions(cls, batch.year, only?.code),
    loadSubjects(cls.targets.map((t) => t.branch), sem),
  ]);
  const semCodes = new Set(curriculum.map((s) => normCode(s.code)));
  const win = semesterWindow(batch.year, sem);
  const inSem = (d: SessionDoc) =>
    d.semester !== undefined ? d.semester === sem : semCodes.has(normCode(d.subjectCode)) || (d.date >= win.from && d.date <= win.to);
  const docs = all.filter(inSem);

  const byCode = new Map<string, ExportSubject>();
  // Curriculum order first (so subjects with no classes yet still appear as "0 held"), then anything else found.
  const base = only ? [only] : curriculum;
  for (const s of base) byCode.set(normCode(s.code), { code: s.code, name: s.name, sessions: [] });
  for (const d of docs) {
    const k = normCode(d.subjectCode);
    if (!byCode.has(k)) byCode.set(k, { code: d.subjectCode, name: d.subjectName, sessions: [] });
    byCode.get(k)!.sessions.push(d);
  }
  const excusals = await loadApprovedExcusals(new Set(ctx.students.map((s) => s.regNo)));
  const title = `${batchLabel(batch)} · ${cls.label} · Semester ${sem}${ctx.specialization ? ` · ${ctx.specialization}` : ''}${only ? ` · ${only.code}` : ''}`;
  const filename = `Attendance_${(cls.section ?? cls.label).replace(/[^A-Za-z0-9]+/g, '-')}_${batch.year}_Sem${sem}${only ? `_${only.code}` : ''}.xlsx`;
  return { subjects: Array.from(byCode.values()), title, filename, excusals };
}

export async function downloadSemesterRegister(ctx: PickerState, only: SubjectOption | null) {
  const p = await prepare(ctx, only);
  const sheets = buildSemesterWorkbook({ title: p.title, students: ctx.students, subjects: p.subjects, excusals: p.excusals.map });
  await downloadXlsx(p.filename, sheets);
}

type Row = { code: string; name: string; held: number; low: number; avg: number | null };

export default function AttendanceExport() {
  const [ctx, setCtx] = useState<PickerState | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [prep, setPrep] = useState<Prepared | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const key = ctx ? `${ctx.batch!.key}|${ctx.cls!.key}|${ctx.semester}|${ctx.subject?.code ?? '*'}|${ctx.specialization}` : '';
  useEffect(() => {
    setRows(null);
    setPrep(null);
    setError('');
    if (!ctx) return;
    let live = true;
    prepare(ctx, ctx.subject)
      .then((p) => {
        if (!live) return;
        setPrep(p);
        setRows(
          p.subjects.map((s) => {
            let low = 0;
            let sum = 0;
            let n = 0;
            for (const st of ctx.students) {
              const r = studentRecord(st, s.sessions.filter((d) => d.branch === st.branch), p.excusals.map.get(st.regNo));
              if (!r.total) continue;
              const pc = (r.attended / r.total) * 100;
              sum += pc;
              n++;
              if (pc < LOW_ATTENDANCE) low++;
            }
            const held = new Set(s.sessions.map((d) => `${d.date}#${d.lecture ?? 1}`)).size;
            return { code: s.code, name: s.name, held, low, avg: n ? Math.round((sum / n) * 10) / 10 : null };
          }),
        );
      })
      .catch((e) => live && setError(`Couldn’t load attendance: ${e.message}`));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const download = async () => {
    if (!ctx || !prep) return;
    setBusy(true);
    try {
      const sheets = buildSemesterWorkbook({ title: prep.title, students: ctx.students, subjects: prep.subjects, excusals: prep.excusals.map });
      await downloadXlsx(prep.filename, sheets);
    } catch (e: any) {
      setError(`Couldn’t build the file: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const totalHeld = rows?.reduce((a, r) => a + r.held, 0) ?? 0;

  return (
    <div className="card att-card">
      <h1 style={{ fontSize: '1.5rem' }}>Download semester attendance</h1>
      <p className="res-hint">
        One Excel file for the whole semester: a Summary sheet (every student’s % in every subject, and who’s below{' '}
        {LOW_ATTENDANCE}%), plus one sheet per subject with every class date. Leave Subject on “All subjects” for the full
        semester.
      </p>

      <AttendanceClassPicker subjectMode="optional" onChange={setCtx} />

      {error && <p className="notice notice-error">{error}</p>}
      {ctx && !rows && !error && <p className="res-hint">Collecting attendance…</p>}

      {ctx && rows && (
        <>
          <table className="att-table">
            <thead>
              <tr>
                <th>Subject</th>
                <th>Classes held</th>
                <th>Class average</th>
                <th>Below {LOW_ATTENDANCE}%</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.code}>
                  <td>
                    <strong>{r.code}</strong> <span className="att-muted">{r.name}</span>
                  </td>
                  <td>{r.held || <span className="att-muted">none yet</span>}</td>
                  <td>{r.avg === null ? '—' : `${r.avg}%`}</td>
                  <td className={r.low ? 'att-bad' : ''}>{r.held ? r.low : '—'}</td>
                </tr>
              ))}
              {!rows.length && (
                <tr>
                  <td colSpan={4} className="att-muted">No subjects found for this semester.</td>
                </tr>
              )}
            </tbody>
          </table>
          {!prep?.excusals.ok && (
            <p className="res-hint">Approved event excusals couldn’t be read, so they show as absences in this file.</p>
          )}
          <button type="button" onClick={download} disabled={busy || !totalHeld} style={{ width: '100%', marginTop: '1rem' }}>
            {busy ? 'Preparing…' : totalHeld ? `Download .xlsx — ${ctx.students.length} students` : 'Nothing recorded yet'}
          </button>
        </>
      )}
    </div>
  );
}
