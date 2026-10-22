import { useEffect, useMemo, useState } from 'react';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  Timestamp,
  updateDoc,
  where,
} from 'firebase/firestore';
import { auth, db } from './firebaseConfig';
import { loadRoster, type RosterRow } from './examData';
import { downloadXlsx } from './xlsxTemplates';

type EventType = 'supplementary' | 'makeup' | 'endsem' | 'midsem' | 'other';
type RegMode = 'none' | 'backlogs' | 'subjects';

const TYPE_LABEL: Record<EventType, string> = {
  supplementary: 'Supplementary exam',
  makeup: 'Make-up exam',
  endsem: 'End-semester exam',
  midsem: 'Mid-semester exam',
  other: 'Exam notice',
};

const MODE_LABEL: Record<RegMode, string> = {
  none: 'Notice only (no registration)',
  backlogs: 'Students pick from their backlog subjects',
  subjects: 'Students pick from this semester\'s subjects',
};

type ExamEvent = {
  id: string;
  title: string;
  type: EventType;
  details: string;
  branches: string[];
  admissionYears: number[];
  registration: RegMode;
  requiresMedical: boolean;
  deadline: Timestamp | null;
  active: boolean;
  link: string | null;
  createdByName: string | null;
  createdAt: Timestamp | null;
};

type Registration = {
  id: string;
  eventId: string;
  enrollmentNumber: string;
  studentName: string;
  branch: string;
  section: string | null;
  admissionYear: number;
  subjects: { code: string; name: string; semester: number; grade: string | null }[];
  medicalDeclared: boolean;
  status: 'submitted' | 'accepted' | 'rejected';
  remark: string | null;
};

const fmt = (t: Timestamp | null) =>
  t ? t.toDate().toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';

const emptyForm = {
  title: '',
  type: 'supplementary' as EventType,
  details: '',
  branches: [] as string[],
  admissionYears: [] as number[],
  registration: 'backlogs' as RegMode,
  requiresMedical: false,
  deadline: '',
  link: '',
};

export default function ExamEvents({ canManage, hodBranches }: { canManage: boolean; hodBranches: string[] }) {
  const [events, setEvents] = useState<ExamEvent[]>([]);
  const [roster, setRoster] = useState<RosterRow[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [regs, setRegs] = useState<Registration[] | null>(null);
  const [remarks, setRemarks] = useState<Record<string, string>>({});

  useEffect(() => {
    const unsub = onSnapshot(
      collection(db, 'examEvents'),
      (snap) =>
        setEvents(
          snap.docs
            .map((d) => ({ id: d.id, ...(d.data() as Omit<ExamEvent, 'id'>) }))
            .sort((a, b) => (b.createdAt?.toMillis() ?? 0) - (a.createdAt?.toMillis() ?? 0)),
        ),
      (e) => setError(`Couldn't load exam notices: ${e.message}`),
    );
    loadRoster().then(setRoster).catch(() => setRoster([]));
    return () => unsub();
  }, []);

  const branchOptions = useMemo(() => Array.from(new Set(roster.map((r) => r.branch))).filter(Boolean).sort(), [roster]);
  const batchOptions = useMemo(() => Array.from(new Set(roster.map((r) => r.admissionYear))).filter(Boolean).sort((a, b) => b - a), [roster]);

  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const create = async () => {
    if (!form.title.trim()) {
      setError('Give the notice a title.');
      return;
    }
    if (form.link.trim() && !/^https?:\/\//i.test(form.link.trim())) {
      setError('The link must start with http:// or https://');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await addDoc(collection(db, 'examEvents'), {
        title: form.title.trim(),
        type: form.type,
        details: form.details.trim(),
        branches: form.branches,
        admissionYears: form.admissionYears,
        registration: form.registration,
        requiresMedical: form.requiresMedical,
        deadline: form.deadline ? Timestamp.fromDate(new Date(form.deadline)) : null,
        active: true,
        link: form.link.trim() || null,
        createdBy: auth.currentUser?.uid ?? null,
        createdByName: auth.currentUser?.email ?? null,
        createdAt: serverTimestamp(),
      });
      setForm(emptyForm);
      setShowForm(false);
    } catch (e: any) {
      setError(`Couldn't publish: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const setActive = async (ev: ExamEvent, active: boolean) => {
    try {
      await updateDoc(doc(db, 'examEvents', ev.id), { active });
    } catch (e: any) {
      setError(e.message);
    }
  };

  const remove = async (ev: ExamEvent) => {
    if (!confirm(`Delete "${ev.title}"? Registrations already made stay in the database.`)) return;
    try {
      await deleteDoc(doc(db, 'examEvents', ev.id));
      if (openId === ev.id) setOpenId(null);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const openRegs = async (ev: ExamEvent) => {
    if (openId === ev.id) {
      setOpenId(null);
      return;
    }
    setOpenId(ev.id);
    setRegs(null);
    try {
      const snaps = canManage
        ? [await getDocs(query(collection(db, 'examRegistrations'), where('eventId', '==', ev.id)))]
        : await Promise.all(
            hodBranches.map((b) => getDocs(query(collection(db, 'examRegistrations'), where('eventId', '==', ev.id), where('branch', '==', b)))),
          );
      const list = snaps
        .flatMap((s) => s.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Registration, 'id'>) })))
        .sort((a, b) => a.enrollmentNumber.localeCompare(b.enrollmentNumber));
      setRegs(list);
    } catch (e: any) {
      setError(`Couldn't load registrations: ${e.message}`);
      setRegs([]);
    }
  };

  const review = async (r: Registration, status: Registration['status']) => {
    try {
      await updateDoc(doc(db, 'examRegistrations', r.id), {
        status,
        remark: (remarks[r.id] ?? r.remark ?? '').trim() || null,
        reviewedBy: auth.currentUser?.uid ?? null,
        updatedAt: serverTimestamp(),
      });
      setRegs((prev) => (prev ?? []).map((x) => (x.id === r.id ? { ...x, status, remark: (remarks[r.id] ?? r.remark ?? '').trim() || null } : x)));
    } catch (e: any) {
      setError(e.message);
    }
  };

  const exportRegs = async (ev: ExamEvent) => {
    if (!regs) return;
    const rows = regs.flatMap((r) =>
      r.subjects.map((s) => [r.enrollmentNumber, r.studentName, r.branch, r.section ?? '', r.admissionYear, s.code, s.name, s.semester, s.grade ?? '', r.medicalDeclared ? 'Yes' : '', r.status, r.remark ?? '']),
    );
    await downloadXlsx(`${ev.title.replace(/[^\w-]+/g, '_')}-registrations.xlsx`, [
      {
        name: 'Registrations',
        rows: [['Enrollment No', 'Name', 'Branch', 'Section', 'Batch', 'Subject Code', 'Subject', 'Semester', 'Grade', 'Medical form', 'Status', 'Remark'], ...rows],
        widths: [14, 28, 8, 8, 7, 12, 36, 9, 7, 12, 10, 30],
      },
    ]);
  };

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: '1rem 0 3rem' }}>
      <h1 style={{ fontSize: '1.5rem', margin: '0 0 0.3rem' }}>Exam notices & registration</h1>
      <p style={{ color: 'var(--ink-soft)', margin: '0 0 1rem', fontSize: '0.9rem' }}>
        Publish supplementary or make-up exam notices. Students get a push notification and register in the app instead of a Google Form.
      </p>
      {error && <p className="notice notice-error">{error}</p>}

      {canManage && !showForm && (
        <button onClick={() => setShowForm(true)} style={{ marginBottom: '1rem' }}>New exam notice</button>
      )}

      {canManage && showForm && (
        <div className="card" style={{ padding: '1.2rem 1.4rem', marginBottom: '1rem' }}>
          <div className="att-row" style={{ marginTop: 0 }}>
            <div className="att-field">
              <label>Type</label>
              <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as EventType, registration: e.target.value === 'makeup' ? 'subjects' : e.target.value === 'supplementary' ? 'backlogs' : 'none', requiresMedical: e.target.value === 'makeup' })}>
                {(Object.keys(TYPE_LABEL) as EventType[]).map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
              </select>
            </div>
            <div className="att-field">
              <label>Registration</label>
              <select value={form.registration} onChange={(e) => setForm({ ...form, registration: e.target.value as RegMode })}>
                {(Object.keys(MODE_LABEL) as RegMode[]).map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
              </select>
            </div>
          </div>
          <div style={{ marginTop: '0.8rem' }}>
            <label>Title</label>
            <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Supplementary Examination, December 2026" />
          </div>
          <div style={{ marginTop: '0.8rem' }}>
            <label>Details</label>
            <textarea rows={3} value={form.details} onChange={(e) => setForm({ ...form, details: e.target.value })} placeholder="Dates, fee, venue, instructions…" />
          </div>
          <div className="att-row">
            <div className="att-field">
              <label>Branches (none ticked = all)</label>
              <div style={{ display: 'flex', gap: '0.8rem', flexWrap: 'wrap' }}>
                {branchOptions.map((b) => (
                  <label key={b} style={{ display: 'flex', gap: '0.35rem', alignItems: 'center', fontWeight: 500 }}>
                    <input type="checkbox" checked={form.branches.includes(b)} onChange={() => setForm({ ...form, branches: toggle(form.branches, b) })} />
                    {b}
                  </label>
                ))}
              </div>
            </div>
            <div className="att-field">
              <label>Batches (none ticked = all)</label>
              <div style={{ display: 'flex', gap: '0.8rem', flexWrap: 'wrap' }}>
                {batchOptions.map((y) => (
                  <label key={y} style={{ display: 'flex', gap: '0.35rem', alignItems: 'center', fontWeight: 500 }}>
                    <input type="checkbox" checked={form.admissionYears.includes(y)} onChange={() => setForm({ ...form, admissionYears: toggle(form.admissionYears, y) })} />
                    {y}
                  </label>
                ))}
              </div>
            </div>
          </div>
          <div className="att-row">
            <div className="att-field">
              <label>Registration deadline</label>
              <input type="datetime-local" value={form.deadline} onChange={(e) => setForm({ ...form, deadline: e.target.value })} />
            </div>
            <div className="att-field">
              <label>Link (optional)</label>
              <input value={form.link} onChange={(e) => setForm({ ...form, link: e.target.value })} placeholder="https://…" />
            </div>
          </div>
          <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '0.8rem', fontWeight: 500 }}>
            <input type="checkbox" checked={form.requiresMedical} onChange={(e) => setForm({ ...form, requiresMedical: e.target.checked })} />
            Only for students who submitted the institute medical form (they must confirm it)
          </label>
          <div style={{ display: 'flex', gap: '0.6rem', marginTop: '1rem' }}>
            <button onClick={create} disabled={busy}>{busy ? 'Publishing…' : 'Publish & notify students'}</button>
            <button className="button-secondary" onClick={() => setShowForm(false)} disabled={busy}>Cancel</button>
          </div>
        </div>
      )}

      {events.length === 0 && <div className="card" style={{ padding: '1.4rem', color: 'var(--ink-soft)' }}>No exam notices yet.</div>}

      {events.map((ev) => (
        <div key={ev.id} className="card" style={{ padding: '1.2rem 1.4rem', marginBottom: '0.8rem', opacity: ev.active ? 1 : 0.75 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
            <div>
              <p className="eyebrow" style={{ margin: 0 }}>{TYPE_LABEL[ev.type] ?? 'Exam notice'}{ev.active ? '' : ' · closed'}</p>
              <strong style={{ fontSize: '1.05rem' }}>{ev.title}</strong>
              <div style={{ color: 'var(--ink-soft)', fontSize: '0.85rem', marginTop: '0.2rem' }}>
                {ev.branches.length ? ev.branches.join(', ') : 'All branches'} · {ev.admissionYears.length ? ev.admissionYears.join(', ') : 'All batches'}
                {ev.deadline ? ` · deadline ${fmt(ev.deadline)}` : ''}
              </div>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'flex-start' }}>
              {ev.registration !== 'none' && (
                <button className="button-secondary" onClick={() => openRegs(ev)}>{openId === ev.id ? 'Hide registrations' : 'Registrations'}</button>
              )}
              {canManage && <button className="button-secondary" onClick={() => setActive(ev, !ev.active)}>{ev.active ? 'Close' : 'Reopen'}</button>}
              {canManage && <button className="button-secondary att-danger" onClick={() => remove(ev)}>Delete</button>}
            </div>
          </div>
          {ev.details && <p style={{ margin: '0.6rem 0 0', whiteSpace: 'pre-wrap' }}>{ev.details}</p>}
          <p className="res-hint">{MODE_LABEL[ev.registration]}{ev.requiresMedical ? ' · medical form required' : ''}</p>

          {openId === ev.id && (
            <div style={{ marginTop: '0.8rem' }}>
              {regs === null ? (
                <p className="res-hint">Loading…</p>
              ) : regs.length === 0 ? (
                <p className="res-hint">No registrations yet.</p>
              ) : (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <strong>{regs.length} student(s)</strong>
                    <button className="button-secondary" onClick={() => exportRegs(ev)}>Download Excel</button>
                  </div>
                  <div style={{ overflowX: 'auto' }}>
                    <table className="att-table">
                      <thead>
                        <tr>
                          <th>Enrollment</th>
                          <th>Name</th>
                          <th>Subjects</th>
                          <th>Medical</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {regs.map((r) => (
                          <tr key={r.id}>
                            <td>{r.enrollmentNumber}</td>
                            <td>
                              {r.studentName}
                              <div style={{ color: 'var(--ink-soft)', fontSize: '0.78rem' }}>{r.branch} {r.section ?? ''}</div>
                            </td>
                            <td>{r.subjects.map((s) => `${s.code}${s.grade ? ` (${s.grade})` : ''}`).join(', ')}</td>
                            <td>{r.medicalDeclared ? 'Yes' : ''}</td>
                            <td style={{ minWidth: 200 }}>
                              {canManage ? (
                                <>
                                  <select value={r.status} onChange={(e) => review(r, e.target.value as Registration['status'])}>
                                    <option value="submitted">Submitted</option>
                                    <option value="accepted">Accepted</option>
                                    <option value="rejected">Not accepted</option>
                                  </select>
                                  <input
                                    style={{ marginTop: '0.3rem' }}
                                    placeholder="Remark for the student"
                                    value={remarks[r.id] ?? r.remark ?? ''}
                                    onChange={(e) => setRemarks({ ...remarks, [r.id]: e.target.value })}
                                    onBlur={() => remarks[r.id] !== undefined && remarks[r.id] !== (r.remark ?? '') && review(r, r.status)}
                                  />
                                </>
                              ) : (
                                <span>{r.status === 'accepted' ? 'Accepted' : r.status === 'rejected' ? 'Not accepted' : 'Submitted'}</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
