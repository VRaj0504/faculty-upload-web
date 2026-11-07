import { useCallback, useEffect, useMemo, useState } from 'react';
import { addDoc, collection, doc, getDocs, query, serverTimestamp, where, writeBatch } from 'firebase/firestore';
import { auth, db } from './firebaseConfig';
import { loadSubjectIndex, type SubjectInfo } from './examData';
import { loadApprovedExcusals, loadRoster } from './attendanceData';
import { normCode, studentRecord, type ExcusalRange, type RosterEntry, type SessionDoc } from './attendanceCore';

type Band = { min: number; marks: number };
type Row = {
  st: RosterEntry;
  attended: number;
  total: number;
  pct: number | null;
  auto: number | null;
  saved: { score: number | null; overridden: boolean } | null;
};

const SEMS = [1, 2, 3, 4, 5, 6, 7, 8];
const ALL = '__all__';
const OUT_OF = [2, 3, 4, 5, 10, 15, 20];
const PCTS = Array.from({ length: 21 }, (_, i) => 100 - i * 5);
const DEFAULT_BANDS: Band[] = [
  { min: 75, marks: 5 },
  { min: 60, marks: 4 },
  { min: 50, marks: 3 },
  { min: 40, marks: 2 },
  { min: 0, marks: 0 },
];
const safe = (c: string) => c.replace(/\s+/g, '').toUpperCase().replace(/\//g, '-');
const LS = (code: string) => `cg-att-bands:${safe(code)}`;

function currentSem(admissionYear: number, now = new Date()) {
  const isOdd = now.getMonth() >= 6;
  const idx = isOdd ? now.getFullYear() - admissionYear : now.getFullYear() - admissionYear - 1;
  return Math.min(8, Math.max(1, idx * 2 + 1 + (isOdd ? 0 : 1)));
}

const classKeyOf = (r: RosterEntry) => `${r.branch}|${r.section ?? ''}|${r.admissionYear}`;
const classLabelOf = (r: RosterEntry) => `${r.branch}${r.section ? ` · ${r.section}` : ''}`;

export function marksFor(pct: number, bands: Band[]): number {
  const sorted = [...bands].sort((a, b) => b.min - a.min);
  for (const b of sorted) if (pct >= b.min) return b.marks;
  return 0;
}

function bandLabel(bands: Band[], i: number): string {
  const sorted = [...bands].sort((a, b) => b.min - a.min);
  const b = sorted[i];
  const upper = i === 0 ? null : sorted[i - 1].min;
  if (upper === null) return `${b.min}% and above`;
  if (b.min === 0) return `Below ${upper}%`;
  return `${b.min}% to under ${upper}%`;
}

export default function AttendanceMarks() {
  const [roster, setRoster] = useState<RosterEntry[] | null>(null);
  const [subjects, setSubjects] = useState<SubjectInfo[]>([]);
  const [loadErr, setLoadErr] = useState('');
  const [semester, setSemester] = useState('');
  const [code, setCode] = useState('');
  const [cls, setCls] = useState(ALL);
  const [outOf, setOutOf] = useState(5);
  const [bands, setBands] = useState<Band[]>(DEFAULT_BANDS);
  const [bandsFrom, setBandsFrom] = useState('');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [excusalsOk, setExcusalsOk] = useState(true);
  const [loading, setLoading] = useState(false);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [notify, setNotify] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState('');

  useEffect(() => {
    Promise.all([loadRoster(), loadSubjectIndex()])
      .then(([r, idx]) => {
        setRoster(r);
        setSubjects(Array.from(idx.values()));
      })
      .catch((e) => setLoadErr(`Couldn't load the student list: ${e.message}`));
  }, []);

  const subjectOptions = useMemo(() => {
    const seen = new Map<string, SubjectInfo & { branches: string[] }>();
    for (const s of subjects) {
      if (String(s.semester) !== semester) continue;
      const hit = seen.get(s.code);
      if (hit) {
        if (!hit.branches.includes(s.branch)) hit.branches.push(s.branch);
      } else seen.set(s.code, { ...s, branches: [s.branch] });
    }
    return Array.from(seen.values()).sort((a, b) => a.code.localeCompare(b.code));
  }, [subjects, semester]);
  const subject = subjectOptions.find((s) => s.code === code) ?? null;

  const takers = useMemo(() => {
    if (!roster || !subject) return [];
    return roster.filter((r) => subject.branches.includes(r.branch) && currentSem(r.admissionYear) === Number(semester));
  }, [roster, subject, semester]);

  const classOptions = useMemo(() => {
    const m = new Map<string, { key: string; label: string; count: number }>();
    for (const r of takers) {
      const k = classKeyOf(r);
      const hit = m.get(k);
      if (hit) hit.count++;
      else m.set(k, { key: k, label: classLabelOf(r), count: 1 });
    }
    return Array.from(m.values()).sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  }, [takers]);

  const students = useMemo(
    () => (cls === ALL ? takers : takers.filter((r) => classKeyOf(r) === cls)).slice().sort((a, b) => a.regNo.localeCompare(b.regNo)),
    [takers, cls],
  );

  useEffect(() => {
    setCls(ALL);
    setRows(null);
    setEdits({});
    setDone('');
  }, [code, semester]);

  useEffect(() => {
    if (!subject) return;
    let alive = true;
    const local = (() => {
      try {
        const raw = localStorage.getItem(LS(subject.code));
        return raw ? (JSON.parse(raw) as { outOf: number; bands: Band[] }) : null;
      } catch {
        return null;
      }
    })();
    const uid = auth.currentUser?.uid;
    (async () => {
      let found: { outOf: number; bands: Band[] } | null = null;
      if (uid) {
        try {
          const snap = await getDocs(query(collection(db, 'marksUploads'), where('uploadedBy', '==', uid)));
          const mine = snap.docs
            .map((d) => d.data() as { subjectCode?: string; attendanceBands?: Band[]; components?: { id: string; max: number }[]; createdAt?: { toMillis?: () => number } })
            .filter((d) => d.subjectCode === subject.code && Array.isArray(d.attendanceBands))
            .sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
          if (mine[0]) found = { bands: mine[0].attendanceBands!, outOf: mine[0].components?.find((c) => c.id === 'attendance')?.max ?? 5 };
        } catch {
          found = null;
        }
      }
      const pick = found ?? local;
      if (!alive) return;
      if (pick) {
        setBands(pick.bands);
        setOutOf(pick.outOf);
        setBandsFrom(found ? 'Your last saved ranges for this subject are filled in.' : 'Your last ranges on this computer are filled in.');
      } else {
        setBands(DEFAULT_BANDS);
        setOutOf(5);
        setBandsFrom('');
      }
    })();
    return () => {
      alive = false;
    };
  }, [subject]);

  const calculate = useCallback(async () => {
    if (!subject || !students.length) return;
    setLoading(true);
    setErr('');
    setDone('');
    try {
      const years = Array.from(new Set(students.map((s) => s.admissionYear)));
      const want = normCode(subject.code);
      const sessions: SessionDoc[] = [];
      for (const y of years) {
        const snap = await getDocs(query(collection(db, 'attendanceSessions'), where('admissionYear', '==', y)));
        snap.docs.forEach((d) => {
          const s = d.data() as SessionDoc;
          if (normCode(s.subjectCode) === want && subject.branches.includes(s.branch)) sessions.push(s);
        });
      }
      sessions.sort((a, b) => a.date.localeCompare(b.date) || (a.lecture ?? 1) - (b.lecture ?? 1));
      const regs = new Set(students.map((s) => s.regNo));
      const ex = await loadApprovedExcusals(regs);
      setExcusalsOk(ex.ok);
      const saved = new Map<string, { score: number | null; overridden: boolean }>();
      try {
        const ms = await getDocs(query(collection(db, 'marks'), where('subjectCode', '==', subject.code)));
        ms.docs.forEach((d) => {
          const x = d.data() as { enrollmentNumber?: string; components?: Record<string, { score?: number | null; overridden?: boolean }> };
          const a = x.components?.attendance;
          if (x.enrollmentNumber && a) saved.set(x.enrollmentNumber, { score: a.score ?? null, overridden: a.overridden === true });
        });
      } catch {
        saved.clear();
      }
      const next: Row[] = students.map((st) => {
        const rec = studentRecord(st, sessions.filter((d) => d.branch === st.branch && d.admissionYear === st.admissionYear), (ex.map.get(st.regNo) ?? []) as ExcusalRange[]);
        const pct = rec.total ? Math.round((rec.attended / rec.total) * 1000) / 10 : null;
        return { st, attended: rec.attended, total: rec.total, pct, auto: null, saved: saved.get(st.regNo) ?? null };
      });
      const prefill: Record<string, string> = {};
      next.forEach((r) => {
        if (r.saved?.overridden && r.saved.score !== null) prefill[r.st.regNo] = String(r.saved.score);
      });
      setEdits(prefill);
      setRows(next);
      if (!sessions.length) setErr(`No attendance is recorded for ${subject.code} yet. Upload or mark attendance first.`);
    } catch (e) {
      setErr(`Couldn't read attendance: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [subject, students]);

  const sortedBands = useMemo(() => [...bands].sort((a, b) => b.min - a.min), [bands]);
  const bandProblem = useMemo(() => {
    const mins = bands.map((b) => b.min);
    if (new Set(mins).size !== mins.length) return 'Two ranges start at the same %. Change one of them.';
    if (!mins.includes(0)) return 'Add a range that starts at 0% so every student gets marks.';
    if (bands.some((b) => b.marks > outOf)) return `A range gives more than ${outOf} marks. Lower it or raise "Out of".`;
    return '';
  }, [bands, outOf]);

  const table = useMemo(() => {
    if (!rows) return [];
    return rows.map((r) => {
      const auto = r.pct === null ? null : marksFor(r.pct, bands);
      const raw = edits[r.st.regNo];
      const typed = raw !== undefined && raw.trim() !== '' ? Number(raw) : null;
      const bad = typed !== null && (!Number.isFinite(typed) || typed < 0 || typed > outOf);
      const final = typed !== null && !bad ? Math.round(typed * 100) / 100 : auto;
      return { ...r, auto, final, overridden: typed !== null && !bad && typed !== auto, bad };
    });
  }, [rows, bands, edits, outOf]);

  const writable = table.filter((r) => r.final !== null && !r.bad);
  const badCount = table.filter((r) => r.bad).length;
  const changedCount = table.filter((r) => r.overridden).length;
  const blocker = !subject
    ? 'Pick the semester and subject.'
    : bandProblem
      ? bandProblem
      : !rows
        ? 'Press "Work out marks" to read attendance.'
        : badCount
          ? `${badCount} typed mark${badCount === 1 ? ' is' : 's are'} not between 0 and ${outOf}.`
          : !writable.length
            ? 'No student has attendance recorded for this subject.'
            : '';

  const setBand = (i: number, patch: Partial<Band>) => setBands((bs) => bs.map((b, k) => (k === i ? { ...b, ...patch } : b)));

  const publish = async () => {
    if (!subject || blocker) return;
    if (
      !confirm(
        `Publish attendance marks (out of ${outOf}) for ${subject.code} ${subject.name} to ${writable.length} students?` +
          (changedCount ? `\n\n${changedCount} of them use the mark you typed instead of the range.` : '') +
          `\n\nStudents ${notify ? 'get a notification and ' : ''}see it in the app. You can come back, change ranges or marks, and publish again.`,
      )
    )
      return;
    setBusy(true);
    setErr('');
    try {
      const by = auth.currentUser;
      for (let i = 0; i < writable.length; i += 400) {
        const b = writeBatch(db);
        for (const r of writable.slice(i, i + 400)) {
          b.set(
            doc(db, 'marks', `${r.st.regNo}_${safe(subject.code)}`),
            {
              enrollmentNumber: r.st.regNo,
              studentName: r.st.name,
              branch: r.st.branch,
              section: r.st.section ?? null,
              admissionYear: r.st.admissionYear,
              semester: Number(semester),
              subjectCode: subject.code,
              subjectName: subject.name,
              components: {
                attendance: {
                  label: 'Attendance',
                  max: outOf,
                  score: r.final,
                  absent: false,
                  percent: r.pct,
                  auto: r.auto,
                  overridden: r.overridden,
                  updatedAt: serverTimestamp(),
                },
              },
              updatedAt: serverTimestamp(),
              updatedBy: by?.uid ?? null,
              updatedByName: by?.displayName ?? by?.email ?? 'Faculty',
            },
            { merge: true },
          );
        }
        await b.commit();
      }
      const clean = sortedBands.map((x) => ({ min: x.min, marks: x.marks }));
      await addDoc(collection(db, 'marksUploads'), {
        subjectCode: subject.code,
        subjectName: subject.name,
        semester: Number(semester),
        components: [{ id: 'attendance', label: 'Attendance', max: outOf }],
        attendanceBands: clean,
        regNos: writable.map((r) => r.st.regNo),
        count: writable.length,
        notify,
        fileName: 'From attendance',
        uploadedBy: by?.uid ?? null,
        uploadedByName: by?.displayName ?? by?.email ?? 'Faculty',
        createdAt: serverTimestamp(),
      });
      try {
        localStorage.setItem(LS(subject.code), JSON.stringify({ outOf, bands: clean }));
      } catch {
        setBandsFrom('');
      }
      setDone(`Done. Attendance marks of ${subject.code} published for ${writable.length} students. Your ranges are saved for next time.`);
      setRows((rs) => (rs ? rs.map((r) => {
        const t = writable.find((w) => w.st.regNo === r.st.regNo);
        return t ? { ...r, saved: { score: t.final, overridden: t.overridden } } : r;
      }) : rs));
    } catch (e) {
      setErr(`Couldn't publish: ${(e as Error).message}. Nothing was lost — try again.`);
    } finally {
      setBusy(false);
    }
  };

  if (loadErr) return <div className="card att-card"><p className="notice notice-error">{loadErr}</p></div>;

  return (
    <div className="card att-card">
      <h1 style={{ fontSize: '1.5rem' }}>Attendance marks</h1>
      <p className="res-hint">
        Marks are worked out from each student's attendance in your subject using ranges you set. You can change any student's mark
        before publishing. Your ranges are remembered for the subject, so next time you only press Publish.
      </p>

      <h3 style={{ margin: '1.2rem 0 0.4rem' }}>1. Subject and class</h3>
      <div className="att-row">
        <div className="att-field att-narrow">
          <label>Semester</label>
          <select value={semester} onChange={(e) => { setSemester(e.target.value); setCode(''); }}>
            <option value="">Pick…</option>
            {SEMS.map((n) => <option key={n} value={n}>Sem {n}</option>)}
          </select>
        </div>
        <div className="att-field att-wide">
          <label>Subject</label>
          <select value={code} onChange={(e) => setCode(e.target.value)} disabled={!semester}>
            <option value="">{semester ? 'Pick the subject…' : 'Pick the semester first'}</option>
            {subjectOptions.map((s) => <option key={s.code} value={s.code}>{s.code} — {s.name}</option>)}
          </select>
        </div>
        <div className="att-field att-narrow">
          <label>Class</label>
          <select value={cls} onChange={(e) => { setCls(e.target.value); setRows(null); }} disabled={!subject || !classOptions.length}>
            <option value={ALL}>{subject ? `All (${takers.length})` : '—'}</option>
            {classOptions.map((c) => <option key={c.key} value={c.key}>{c.label} ({c.count})</option>)}
          </select>
        </div>
      </div>
      {!roster && <p className="res-hint">Loading the student list…</p>}

      <h3 style={{ margin: '1.2rem 0 0.4rem' }}>2. Mark ranges</h3>
      {bandsFrom && <p className="res-hint">{bandsFrom}</p>}
      <div className="att-row" style={{ alignItems: 'flex-end' }}>
        <div className="att-field att-narrow">
          <label>Attendance marks out of</label>
          <select value={outOf} onChange={(e) => setOutOf(Number(e.target.value))}>
            {OUT_OF.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
      </div>
      <table className="att-table" style={{ maxWidth: 560 }}>
        <thead>
          <tr><th>Attendance from</th><th>Range</th><th style={{ width: 110 }}>Marks</th><th style={{ width: 70 }} /></tr>
        </thead>
        <tbody>
          {sortedBands.map((b, si) => {
            const i = bands.indexOf(b);
            return (
              <tr key={`${b.min}-${si}`}>
                <td>
                  <select value={b.min} onChange={(e) => setBand(i, { min: Number(e.target.value) })}>
                    {PCTS.map((p) => <option key={p} value={p}>{p}%</option>)}
                  </select>
                </td>
                <td>{bandLabel(bands, si)}</td>
                <td>
                  <select value={b.marks} onChange={(e) => setBand(i, { marks: Number(e.target.value) })}>
                    {Array.from({ length: outOf * 2 + 1 }, (_, k) => k / 2).map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                </td>
                <td>
                  <button type="button" className="button-secondary" onClick={() => setBands((bs) => bs.filter((_, k) => k !== i))} disabled={bands.length <= 1}>
                    Remove
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div style={{ display: 'flex', gap: '0.6rem', marginTop: '0.6rem', flexWrap: 'wrap' }}>
        <button
          type="button"
          className="button-secondary"
          onClick={() => {
            const used = new Set(bands.map((b) => b.min));
            const free = PCTS.find((p) => !used.has(p));
            if (free !== undefined) setBands((bs) => [...bs, { min: free, marks: 0 }]);
          }}
        >
          Add a range
        </button>
        <button type="button" className="button-secondary" onClick={() => { setBands(DEFAULT_BANDS.map((b) => ({ ...b, marks: Math.min(b.marks, outOf) }))); }}>
          Reset to 75 / 60 / 50 / 40
        </button>
      </div>
      {bandProblem && <p className="notice notice-warn">{bandProblem}</p>}

      <h3 style={{ margin: '1.2rem 0 0.4rem' }}>3. Check and change marks</h3>
      <button type="button" onClick={calculate} disabled={!subject || !students.length || loading}>
        {loading ? 'Reading attendance…' : rows ? 'Read attendance again' : `Work out marks${students.length ? ` for ${students.length} students` : ''}`}
      </button>
      {err && <p className="notice notice-error">{err}</p>}
      {done && <p className="notice notice-ok">{done}</p>}
      {!excusalsOk && <p className="res-hint">Approved event or medical-leave excusals couldn’t be read, so they count as absences here.</p>}

      {rows && (
        <>
          <div className="att-summary" style={{ marginTop: '1rem' }}>
            <div><strong>{writable.length}</strong><span>will get marks</span></div>
            <div><strong>{changedCount}</strong><span>changed by you</span></div>
            <div><strong>{table.filter((r) => r.pct === null).length}</strong><span>no classes recorded</span></div>
          </div>
          <p className="res-hint">Type in the "Final" box to give a different mark. Clear the box to go back to the range.</p>
          <div style={{ maxHeight: 460, overflow: 'auto', marginTop: '0.6rem' }}>
            <table className="att-table">
              <thead>
                <tr><th>Enrollment</th><th>Name</th><th>Attended</th><th>%</th><th>From range</th><th style={{ width: 120 }}>Final (out of {outOf})</th></tr>
              </thead>
              <tbody>
                {table.map((r) => (
                  <tr key={r.st.regNo} className={r.pct === null ? 'att-off' : ''}>
                    <td>{r.st.regNo}</td>
                    <td>{r.st.name}</td>
                    <td>{r.total ? `${r.attended} / ${r.total}` : '—'}</td>
                    <td>{r.pct === null ? '—' : `${r.pct}%`}</td>
                    <td>{r.auto ?? '—'}</td>
                    <td>
                      <input
                        type="number"
                        min={0}
                        max={outOf}
                        step={0.5}
                        disabled={r.pct === null}
                        value={edits[r.st.regNo] ?? ''}
                        placeholder={r.auto === null ? '' : String(r.auto)}
                        onChange={(e) => setEdits((m) => ({ ...m, [r.st.regNo]: e.target.value }))}
                        style={{ width: 90, ...(r.bad ? { borderColor: '#C1272D' } : r.overridden ? { borderColor: '#b45309', fontWeight: 700 } : {}) }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <label className="med-remember" style={{ marginTop: '1rem' }}>
            <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Notify students in the app
          </label>
          {blocker && <p className="res-hint" style={{ color: '#b45309' }}>{blocker}</p>}
          <button type="button" onClick={publish} disabled={busy || !!blocker} style={{ width: '100%', marginTop: '0.8rem' }}>
            {busy ? 'Publishing…' : `Publish attendance marks to ${writable.length} students`}
          </button>
        </>
      )}
    </div>
  );
}
