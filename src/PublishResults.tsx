import { useEffect, useMemo, useState } from 'react';
import { doc, getDoc, serverTimestamp, updateDoc, writeBatch } from 'firebase/firestore';
import { auth, db } from './firebaseConfig';
import { loadGrades, loadRoster, type GradeDoc, type RosterRow } from './examData';

type Mode = 'instant' | 'examCell';

export default function PublishResults() {
  const [mode, setMode] = useState<Mode | null>(null);
  const [modeBusy, setModeBusy] = useState(false);
  const [roster, setRoster] = useState<RosterRow[]>([]);
  const [batch, setBatch] = useState('');
  const [branch, setBranch] = useState('');
  const [semester, setSemester] = useState('');
  const [grades, setGrades] = useState<GradeDoc[] | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getDoc(doc(db, 'config', 'exams'))
      .then((s) => setMode(((s.data() as { publishMode?: Mode } | undefined)?.publishMode ?? 'instant') as Mode))
      .catch(() => setMode('instant'));
    loadRoster().then(setRoster).catch(() => setRoster([]));
  }, []);

  const batches = useMemo(
    () => Array.from(new Set(roster.map((r) => r.admissionYear))).filter(Boolean).sort((a, b) => b - a),
    [roster],
  );
  const branches = useMemo(
    () => Array.from(new Set(roster.filter((r) => String(r.admissionYear) === batch).map((r) => r.branch))).filter(Boolean).sort(),
    [roster, batch],
  );

  useEffect(() => {
    setGrades(null);
    if (!batch || !branch) return;
    loadGrades(Number(batch), branch)
      .then(setGrades)
      .catch((e) => setStatus(`Couldn't load grades: ${e.message}`));
  }, [batch, branch]);

  const pending = useMemo(
    () =>
      (grades ?? []).filter(
        (g) => (g as GradeDoc & { published?: boolean }).published === false && (!semester || String(g.subjectSemester) === semester),
      ),
    [grades, semester],
  );
  const bySubject = useMemo(() => {
    const m = new Map<string, { code: string; name: string; count: number }>();
    for (const g of pending) {
      const e = m.get(g.subjectCode) ?? { code: g.subjectCode, name: g.subjectName, count: 0 };
      e.count++;
      m.set(g.subjectCode, e);
    }
    return Array.from(m.values()).sort((a, b) => a.code.localeCompare(b.code));
  }, [pending]);

  const changeMode = async (next: Mode) => {
    setModeBusy(true);
    try {
      await updateDoc(doc(db, 'config', 'exams'), { publishMode: next });
      setMode(next);
    } catch (e: any) {
      alert(`Couldn't change the setting: ${e.message}`);
    } finally {
      setModeBusy(false);
    }
  };

  const publish = async (codes: string[] | null) => {
    const list = codes ? pending.filter((g) => codes.includes(g.subjectCode)) : pending;
    if (list.length === 0) return;
    if (!confirm(`Publish ${list.length} grade${list.length === 1 ? '' : 's'}? Students will see them and get a notification.`)) return;
    setBusy(true);
    setStatus('Publishing…');
    try {
      for (let i = 0; i < list.length; i += 400) {
        const b = writeBatch(db);
        for (const g of list.slice(i, i + 400)) {
          b.update(doc(db, 'grades', g.id), {
            published: true,
            publishedAt: serverTimestamp(),
            publishedBy: auth.currentUser?.uid ?? null,
          });
        }
        await b.commit();
      }
      setStatus(`Published ${list.length} grade${list.length === 1 ? '' : 's'}.`);
      setGrades(await loadGrades(Number(batch), branch));
    } catch (e: any) {
      setStatus(`Publish failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: '1rem 0 0' }}>
      <h1 style={{ fontSize: '1.5rem', margin: '0 0 0.3rem' }}>Publish results</h1>
      <div className="card" style={{ padding: '1.2rem 1.4rem' }}>
        <div className="att-row" style={{ marginTop: 0 }}>
          <div className="att-field">
            <label>When faculty save grades</label>
            <select
              value={mode ?? 'instant'}
              disabled={mode === null || modeBusy}
              onChange={(e) => changeMode(e.target.value as Mode)}
            >
              <option value="instant">Students see them straight away</option>
              <option value="examCell">Hold until the exam cell publishes</option>
            </select>
          </div>
        </div>
        <p className="res-hint">
          {mode === 'examCell'
            ? 'Grades entered by faculty stay hidden from students until you publish them below.'
            : 'Grades go live as soon as faculty save them. Switch to "Hold" before results week to review them first.'}
        </p>

        <div className="att-row">
          <div className="att-field">
            <label>Batch (admission year)</label>
            <select value={batch} onChange={(e) => { setBatch(e.target.value); setBranch(''); setStatus(''); }}>
              <option value="">Select…</option>
              {batches.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
          <div className="att-field">
            <label>Branch</label>
            <select value={branch} disabled={!batch} onChange={(e) => { setBranch(e.target.value); setStatus(''); }}>
              <option value="">Select…</option>
              {branches.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>
          <div className="att-field">
            <label>Semester</label>
            <select value={semester} onChange={(e) => setSemester(e.target.value)}>
              <option value="">All semesters</option>
              {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => <option key={n} value={n}>Semester {n}</option>)}
            </select>
          </div>
        </div>

        {batch && branch && grades === null && <p className="res-hint">Loading grades…</p>}
        {grades !== null && bySubject.length === 0 && <p className="res-hint">Nothing waiting to be published for this batch.</p>}
        {bySubject.length > 0 && (
          <div style={{ marginTop: '0.8rem' }}>
            {bySubject.map((s) => (
              <div
                key={s.code}
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.6rem', padding: '0.45rem 0', borderBottom: '1px solid var(--line)' }}
              >
                <span>
                  <strong>{s.code}</strong> {s.name} <span style={{ color: 'var(--ink-soft)' }}>· {s.count} unpublished</span>
                </span>
                <button className="button-secondary" disabled={busy} onClick={() => publish([s.code])}>Publish</button>
              </div>
            ))}
            <button style={{ marginTop: '0.8rem' }} disabled={busy} onClick={() => publish(null)}>
              Publish all {pending.length}
            </button>
          </div>
        )}
        {status && <p className="res-hint">{status}</p>}
      </div>
    </div>
  );
}
