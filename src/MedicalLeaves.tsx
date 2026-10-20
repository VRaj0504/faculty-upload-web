import { useEffect, useMemo, useState } from 'react';
import {
  collection,
  collectionGroup,
  query,
  where,
  onSnapshot,
  doc,
  getDoc,
  updateDoc,
  serverTimestamp,
  Timestamp,
} from 'firebase/firestore';
import { auth, db } from './firebaseConfig';

// Medical leave desk — same data and same rules as the mobile app's
// LeaveRequestsScreen.tsx / leaveService.ts, so acting here or in the app
// is identical (and triggers the same medicalLeaveWorkflow notifications).
//
//   student → Doctor (step 1) → HOD of the student's branch (step 2)
//           → each teacher whose class was missed confirms (step 3) → done
//
// Each section only appears for someone who has work in it.

type Stage = 'doctor' | 'hod' | 'teachers' | 'done' | 'rejected';
type Decision = { decision: 'approved' | 'rejected'; remark: string | null; by: string; byName: string };

type Leave = {
  id: string;
  type: 'medical' | 'casual';
  stage?: Stage;
  studentName: string;
  studentEnrollmentNumber?: string;
  fromDate: string;
  toDate: string;
  reason: string;
  medicalReportUrl?: string | null;
  doctorName?: string;
  hodName?: string;
  doctorDecision?: Decision;
  hodDecision?: Decision;
  teachersTotal?: number;
  teachersConfirmed?: number;
  unmatchedFaculty?: string[];
  createdAt: Timestamp | null;
};

type Ack = {
  id: string;
  leaveId: string;
  studentName: string;
  studentEnrollmentNumber: string | null;
  fromDate: string;
  toDate: string;
  subjects: { code: string; name: string; dates: string[] }[];
  status: 'pending' | 'confirmed';
  createdAt: Timestamp | null;
};

const newestFirst = <T extends { createdAt: Timestamp | null }>(xs: T[]) =>
  [...xs].sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));

function prettyDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
}

function days(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00`).getTime();
  const b = new Date(`${to}T00:00:00`).getTime();
  return b >= a ? Math.round((b - a) / 86400000) + 1 : 0;
}

const STAGE_LABEL: Record<Stage, string> = {
  doctor: 'With doctor',
  hod: 'With HOD',
  teachers: 'With teachers',
  done: 'Complete',
  rejected: 'Rejected',
};

export default function MedicalLeaves() {
  const [me, setMe] = useState<{ uid: string; email: string; name: string } | null>(null);
  const [asDoctor, setAsDoctor] = useState<Leave[]>([]);
  const [asHod, setAsHod] = useState<Leave[]>([]);
  const [acks, setAcks] = useState<Ack[]>([]);
  const [remarks, setRemarks] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  // The rules match on the email stored on the users/{uid} profile, so
  // that's the email used here too (not whatever was typed at login).
  useEffect(() => {
    const u = auth.currentUser;
    if (!u) return;
    getDoc(doc(db, 'users', u.uid))
      .then((snap) => {
        const d = snap.data() as { email?: string; name?: string } | undefined;
        setMe({ uid: u.uid, email: (d?.email ?? u.email ?? '').toLowerCase(), name: d?.name ?? u.email ?? 'Faculty' });
      })
      .catch(() => setError('Could not load your profile.'));
  }, []);

  useEffect(() => {
    if (!me?.email) return;
    const fail = (e: Error) => setError(e.message);
    const unsubs = [
      onSnapshot(
        query(collection(db, 'leaveApplications'), where('doctorEmail', '==', me.email)),
        (s) => setAsDoctor(newestFirst(s.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Leave, 'id'>) })))),
        fail,
      ),
      onSnapshot(
        query(collection(db, 'leaveApplications'), where('hodEmail', '==', me.email)),
        (s) => setAsHod(newestFirst(s.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Leave, 'id'>) })))),
        fail,
      ),
      onSnapshot(
        query(collectionGroup(db, 'teacherAcks'), where('email', '==', me.email)),
        (s) => setAcks(newestFirst(s.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Ack, 'id'>) })))),
        fail,
      ),
    ];
    return () => unsubs.forEach((u) => u());
  }, [me?.email]);

  const pendingDoctor = useMemo(() => asDoctor.filter((l) => l.stage === 'doctor'), [asDoctor]);
  const pendingHod = useMemo(() => asHod.filter((l) => l.stage === 'hod'), [asHod]);
  const pendingAcks = useMemo(() => acks.filter((a) => a.status === 'pending'), [acks]);
  const history = useMemo(() => {
    const seen = new Set<string>();
    return [...asDoctor, ...asHod]
      .filter((l) => l.stage !== 'doctor' && !(asHod.includes(l) && l.stage === 'hod'))
      .filter((l) => (seen.has(l.id) ? false : (seen.add(l.id), true)));
  }, [asDoctor, asHod]);

  async function decide(leave: Leave, role: 'doctor' | 'hod', decision: 'approved' | 'rejected') {
    if (!me) return;
    const remark = remarks[leave.id]?.trim() || null;
    if (decision === 'rejected' && !remark) {
      alert('Write a short remark first, so the student knows why it was rejected.');
      return;
    }
    const next = role === 'doctor' ? `${leave.hodName ?? 'the HOD'} for approval` : "the student's teachers";
    if (!confirm(decision === 'approved' ? `Approve? It will go to ${next}.` : 'Reject this medical leave?')) return;
    setBusy(leave.id);
    setError('');
    try {
      const approved = decision === 'approved';
      await updateDoc(doc(db, 'leaveApplications', leave.id), {
        stage: !approved ? 'rejected' : role === 'doctor' ? 'hod' : 'teachers',
        status: !approved ? 'rejected' : role === 'hod' ? 'approved' : 'pending',
        [role === 'doctor' ? 'doctorDecision' : 'hodDecision']: {
          decision,
          remark,
          by: me.uid,
          byName: me.name,
          at: serverTimestamp(),
        },
        facultyRemark: remark,
        resolvedAt: serverTimestamp(),
        resolvedBy: me.uid,
      });
    } catch (e) {
      setError(`Could not update: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  async function confirmAck(ack: Ack) {
    if (!me) return;
    if (!confirm(`Confirm you've marked ${ack.studentName}'s attendance as excused for these classes?`)) return;
    const key = ack.leaveId + ack.id;
    setBusy(key);
    setError('');
    try {
      await updateDoc(doc(db, 'leaveApplications', ack.leaveId, 'teacherAcks', ack.id), {
        status: 'confirmed',
        confirmedAt: serverTimestamp(),
        confirmedBy: me.uid,
        remark: remarks[key]?.trim() || null,
      });
    } catch (e) {
      setError(`Could not confirm: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  const remarkBox = (key: string, placeholder: string) => (
    <input
      value={remarks[key] ?? ''}
      onChange={(e) => setRemarks((r) => ({ ...r, [key]: e.target.value }))}
      placeholder={placeholder}
      style={{ marginTop: '0.8rem' }}
    />
  );

  const leaveCard = (l: Leave, role: 'doctor' | 'hod') => (
    <div key={`${role}-${l.id}`} className="card" style={{ padding: '1.4rem 1.6rem', marginBottom: '1rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', alignItems: 'baseline', flexWrap: 'wrap' }}>
        <strong style={{ fontSize: '1.05rem' }}>{l.studentName}</strong>
        <span className="eyebrow" style={{ margin: 0 }}>{role === 'doctor' ? 'Step 1 · Doctor' : 'Step 2 · HOD'}</span>
      </div>
      <div style={{ color: 'var(--ink-soft)', fontSize: '0.85rem', marginTop: '0.2rem' }}>
        {l.studentEnrollmentNumber ? `${l.studentEnrollmentNumber} · ` : ''}
        {prettyDate(l.fromDate)} → {prettyDate(l.toDate)} · {days(l.fromDate, l.toDate)} day(s)
      </div>
      <p style={{ margin: '0.7rem 0 0' }}>{l.reason}</p>
      {l.medicalReportUrl && (
        <a href={l.medicalReportUrl} target="_blank" rel="noreferrer" style={{ display: 'inline-block', marginTop: '0.6rem', fontWeight: 600 }}>
          Open medical report ↗
        </a>
      )}
      {role === 'hod' && l.doctorDecision && (
        <p style={{ margin: '0.6rem 0 0', fontSize: '0.85rem' }}>
          ✓ Approved by {l.doctorDecision.byName}
          {l.doctorDecision.remark ? `: “${l.doctorDecision.remark}”` : ''}
        </p>
      )}
      {remarkBox(l.id, 'Remark (required to reject)')}
      <div style={{ display: 'flex', gap: '0.6rem', marginTop: '0.8rem', flexWrap: 'wrap' }}>
        <button disabled={busy === l.id} onClick={() => decide(l, role, 'approved')}>
          {role === 'doctor' ? 'Approve → HOD' : 'Approve → Teachers'}
        </button>
        <button className="button-secondary" disabled={busy === l.id} onClick={() => decide(l, role, 'rejected')}>
          Reject
        </button>
      </div>
    </div>
  );

  const nothing = pendingDoctor.length + pendingHod.length + pendingAcks.length === 0;

  return (
    <div style={{ maxWidth: 760, margin: '0 auto', padding: '1rem 0 3rem' }}>
      <h1 style={{ fontSize: '1.5rem', margin: '0 0 0.3rem' }}>Medical Leaves</h1>
      <p style={{ color: 'var(--ink-soft)', margin: '0 0 1.2rem', fontSize: '0.9rem' }}>
        Doctor → HOD → teachers. You only see the steps that are yours.
      </p>
      {error && <p className="error-text">{error}</p>}

      {pendingDoctor.length > 0 && (
        <>
          <p className="eyebrow">Check report · {pendingDoctor.length}</p>
          {pendingDoctor.map((l) => leaveCard(l, 'doctor'))}
        </>
      )}

      {pendingHod.length > 0 && (
        <>
          <p className="eyebrow">Approve as HOD · {pendingHod.length}</p>
          {pendingHod.map((l) => leaveCard(l, 'hod'))}
        </>
      )}

      {pendingAcks.length > 0 && (
        <>
          <p className="eyebrow">Excuse missed classes · {pendingAcks.length}</p>
          {pendingAcks.map((a) => {
            const key = a.leaveId + a.id;
            return (
              <div key={key} className="card" style={{ padding: '1.4rem 1.6rem', marginBottom: '1rem' }}>
                <strong style={{ fontSize: '1.05rem' }}>{a.studentName}</strong>
                <div style={{ color: 'var(--ink-soft)', fontSize: '0.85rem', marginTop: '0.2rem' }}>
                  {a.studentEnrollmentNumber ? `${a.studentEnrollmentNumber} · ` : ''}approved medical leave{' '}
                  {prettyDate(a.fromDate)} → {prettyDate(a.toDate)}
                </div>
                <p style={{ margin: '0.8rem 0 0.3rem', fontSize: '0.85rem', fontWeight: 600 }}>Your classes they missed:</p>
                <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>
                  {a.subjects.map((s) => (
                    <li key={s.code} style={{ marginBottom: '0.3rem' }}>
                      <strong>{s.name}</strong> ({s.code}) — {s.dates.map(prettyDate).join(', ')}
                    </li>
                  ))}
                </ul>
                {remarkBox(key, 'Optional note')}
                <button style={{ marginTop: '0.8rem' }} disabled={busy === key} onClick={() => confirmAck(a)}>
                  Mark these classes excused
                </button>
              </div>
            );
          })}
        </>
      )}

      {nothing && (
        <div className="card" style={{ padding: '1.6rem', textAlign: 'center', color: 'var(--ink-soft)' }}>
          Nothing waiting for you right now.
        </div>
      )}

      {history.length > 0 && (
        <>
          <p className="eyebrow" style={{ marginTop: '2rem' }}>Already handled</p>
          <div className="card" style={{ padding: '0.4rem 1.4rem' }}>
            {history.map((l) => (
              <div key={l.id} style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', padding: '0.7rem 0', borderBottom: '1px solid var(--line)', flexWrap: 'wrap' }}>
                <span>
                  <strong>{l.studentName}</strong> · {l.fromDate} → {l.toDate}
                </span>
                <span style={{ color: l.stage === 'rejected' ? '#b42318' : 'var(--ink-soft)', fontSize: '0.85rem' }}>
                  {STAGE_LABEL[l.stage ?? 'doctor']}
                  {l.stage === 'teachers' ? ` · ${l.teachersConfirmed ?? 0}/${l.teachersTotal ?? 0} confirmed` : ''}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
