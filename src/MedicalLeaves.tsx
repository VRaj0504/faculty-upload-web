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

type Role = 'doctor' | 'dr' | 'dean' | 'hod';
type Stage = Role | 'teachers' | 'done' | 'rejected';
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
  drName?: string;
  deanName?: string;
  hodName?: string;
  drEmail?: string;
  deanEmail?: string;
  doctorDecision?: Decision;
  drDecision?: Decision;
  deanDecision?: Decision;
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
  status: 'pending' | 'confirmed' | 'excused' | 'declined';
  declinedSessions?: string[];
  remark?: string | null;
  createdAt: Timestamp | null;
};

const ROLES: Role[] = ['doctor', 'dr', 'dean', 'hod'];

const ROLE_LABEL: Record<Role, string> = {
  doctor: 'Doctor',
  dr: 'Deputy Registrar',
  dean: 'Dean (Academics)',
  hod: 'HOD',
};

const ROLE_SECTION: Record<Role, string> = {
  doctor: 'Check report',
  dr: 'Approve as Deputy Registrar',
  dean: 'Approve as Dean',
  hod: 'Approve as HOD',
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

function isoDaysAgo(n: number): string {
  const d = new Date(Date.now() - n * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function chainOf(l: Leave): Role[] {
  const c: Role[] = ['doctor'];
  if (l.drEmail) c.push('dr');
  if (l.deanEmail) c.push('dean');
  c.push('hod');
  return c;
}

function nextStage(role: Role, l: Leave): Stage {
  const c = chainOf(l);
  const i = c.indexOf(role);
  return i >= 0 && i < c.length - 1 ? c[i + 1] : 'teachers';
}

function nameOf(role: Role, l: Leave): string {
  const n = role === 'doctor' ? l.doctorName : role === 'dr' ? l.drName : role === 'dean' ? l.deanName : l.hodName;
  return n || `the ${ROLE_LABEL[role]}`;
}

function stageLabel(l: Leave): string {
  const s = l.stage ?? 'doctor';
  if (s === 'teachers' || s === 'done') return 'Approved';
  if (s === 'rejected') return 'Rejected';
  return `With ${ROLE_LABEL[s]}`;
}

export default function MedicalLeaves() {
  const [me, setMe] = useState<{ uid: string; email: string; name: string } | null>(null);
  const [byRole, setByRole] = useState<Record<Role, Leave[]>>({ doctor: [], dr: [], dean: [], hod: [] });
  const [acks, setAcks] = useState<Ack[]>([]);
  const [remarks, setRemarks] = useState<Record<string, string>>({});
  const [declinedDraft, setDeclinedDraft] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

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
      ...ROLES.map((role) =>
        onSnapshot(
          query(collection(db, 'leaveApplications'), where(`${role}Email`, '==', me.email)),
          (s) =>
            setByRole((prev) => ({
              ...prev,
              [role]: newestFirst(s.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Leave, 'id'>) }))),
            })),
          fail,
        ),
      ),
      onSnapshot(
        query(collectionGroup(db, 'teacherAcks'), where('email', '==', me.email)),
        (s) => setAcks(newestFirst(s.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Ack, 'id'>) })))),
        fail,
      ),
    ];
    return () => unsubs.forEach((u) => u());
  }, [me?.email]);

  const pending = useMemo(() => {
    const out = {} as Record<Role, Leave[]>;
    for (const r of ROLES) out[r] = byRole[r].filter((l) => l.stage === r);
    return out;
  }, [byRole]);
  const pendingCount = ROLES.reduce((n, r) => n + pending[r].length, 0);
  const cutoff = isoDaysAgo(30);
  const pendingAcks = useMemo(() => acks.filter((a) => a.status === 'pending'), [acks]);
  const recentAcks = useMemo(() => acks.filter((a) => a.status !== 'pending' && a.toDate >= cutoff), [acks, cutoff]);
  const history = useMemo(() => {
    const seen = new Set<string>();
    const out: { leave: Leave; role: Role }[] = [];
    for (const r of ROLES) {
      for (const l of byRole[r]) {
        if (l.stage === r || seen.has(l.id)) continue;
        seen.add(l.id);
        out.push({ leave: l, role: r });
      }
    }
    return out;
  }, [byRole]);

  async function decide(leave: Leave, role: Role, decision: 'approved' | 'rejected') {
    if (!me) return;
    const remark = remarks[leave.id]?.trim() || null;
    if (decision === 'rejected' && !remark) {
      alert('Write a short remark first, so the student knows why it was rejected.');
      return;
    }
    const next = nextStage(role, leave);
    const nextText =
      next === 'teachers' ? "final approval. The student's classes in these dates will count as present" : `${nameOf(next as Role, leave)} for approval`;
    if (!confirm(decision === 'approved' ? `Approve? It goes to ${nextText}.` : 'Reject this medical leave?')) return;
    setBusy(leave.id);
    setError('');
    try {
      const approved = decision === 'approved';
      const stage: Stage = approved ? next : 'rejected';
      await updateDoc(doc(db, 'leaveApplications', leave.id), {
        stage,
        status: !approved ? 'rejected' : stage === 'teachers' ? 'approved' : 'pending',
        [`${role}Decision`]: {
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

  const declinedFor = (a: Ack) => declinedDraft[a.leaveId + a.id] ?? a.declinedSessions ?? [];

  const toggle = (a: Ack, key: string) => {
    const cur = declinedFor(a);
    setDeclinedDraft((p) => ({ ...p, [a.leaveId + a.id]: cur.includes(key) ? cur.filter((x) => x !== key) : [...cur, key] }));
  };

  async function saveAck(a: Ack, status: 'excused' | 'declined') {
    if (!me) return;
    if (status === 'declined' && !confirm(`Don't excuse any of ${a.studentName}'s classes with you in these dates?`)) return;
    const key = a.leaveId + a.id;
    setBusy(key);
    setError('');
    try {
      await updateDoc(doc(db, 'leaveApplications', a.leaveId, 'teacherAcks', a.id), {
        status,
        declinedSessions: status === 'declined' ? [] : declinedFor(a),
        confirmedAt: serverTimestamp(),
        confirmedBy: me.uid,
        remark: (remarks[key] ?? a.remark ?? '').trim() || null,
      });
      setDeclinedDraft((p) => {
        const n = { ...p };
        delete n[key];
        return n;
      });
    } catch (e) {
      setError(`Could not save: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  const remarkBox = (key: string, placeholder: string, initial = '') => (
    <input
      value={remarks[key] ?? initial}
      onChange={(e) => setRemarks((r) => ({ ...r, [key]: e.target.value }))}
      placeholder={placeholder}
      style={{ marginTop: '0.8rem' }}
    />
  );

  const leaveCard = (l: Leave, role: Role) => {
    const chain = chainOf(l);
    const step = chain.indexOf(role) + 1;
    const next = nextStage(role, l);
    const prior = chain.slice(0, chain.indexOf(role));
    return (
      <div key={`${role}-${l.id}`} className="card" style={{ padding: '1.4rem 1.6rem', marginBottom: '1rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', alignItems: 'baseline', flexWrap: 'wrap' }}>
          <strong style={{ fontSize: '1.05rem' }}>{l.studentName}</strong>
          <span className="eyebrow" style={{ margin: 0 }}>
            Step {step} of {chain.length} · {ROLE_LABEL[role]}
          </span>
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
        {prior.map((r) => {
          const d = l[`${r}Decision`];
          if (!d) return null;
          return (
            <p key={r} style={{ margin: '0.6rem 0 0', fontSize: '0.85rem' }}>
              ✓ {ROLE_LABEL[r]}: approved by {d.byName}
              {d.remark ? `: “${d.remark}”` : ''}
            </p>
          );
        })}
        {remarkBox(l.id, 'Remark (required to reject)')}
        <div style={{ display: 'flex', gap: '0.6rem', marginTop: '0.8rem', flexWrap: 'wrap' }}>
          <button disabled={busy === l.id} onClick={() => decide(l, role, 'approved')}>
            {next === 'teachers' ? 'Final approve' : `Approve → ${ROLE_LABEL[next as Role]}`}
          </button>
          <button className="button-secondary" disabled={busy === l.id} onClick={() => decide(l, role, 'rejected')}>
            Reject
          </button>
        </div>
      </div>
    );
  };

  const ackCard = (a: Ack) => {
    const key = a.leaveId + a.id;
    const declined = declinedFor(a);
    const allOff = a.status === 'declined';
    const total = a.subjects.reduce((n, s) => n + s.dates.length, 0);
    const dirty = declinedDraft[key] !== undefined || remarks[key] !== undefined;
    return (
      <div key={key} className="card" style={{ padding: '1.4rem 1.6rem', marginBottom: '1rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', alignItems: 'baseline', flexWrap: 'wrap' }}>
          <strong style={{ fontSize: '1.05rem' }}>{a.studentName}</strong>
          <span style={{ fontSize: '0.8rem', fontWeight: 700, color: allOff ? '#b42318' : '#15803D' }}>
            {allOff ? 'Not excused' : a.status === 'pending' ? 'Waiting for you' : `${total - declined.length}/${total} excused`}
          </span>
        </div>
        <div style={{ color: 'var(--ink-soft)', fontSize: '0.85rem', marginTop: '0.2rem' }}>
          {a.studentEnrollmentNumber ? `${a.studentEnrollmentNumber} · ` : ''}approved medical leave {prettyDate(a.fromDate)} → {prettyDate(a.toDate)}
        </div>
        <p style={{ margin: '0.8rem 0 0.3rem', fontSize: '0.85rem' }}>
          These classes count as present automatically. Click a class to not excuse it.
        </p>
        {a.subjects.map((s) => (
          <div key={s.code} style={{ marginBottom: '0.5rem' }}>
            <strong style={{ fontSize: '0.9rem' }}>{s.name}</strong> <span style={{ color: 'var(--ink-soft)' }}>({s.code})</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', marginTop: '0.3rem' }}>
              {s.dates.map((d) => {
                const k = `${s.code}|${d}`;
                const off = allOff || declined.includes(k);
                return (
                  <button
                    key={k}
                    type="button"
                    disabled={allOff}
                    onClick={() => toggle(a, k)}
                    className="button-secondary"
                    aria-pressed={!off}
                    style={{
                      padding: '0.35rem 0.75rem',
                      fontSize: '0.8rem',
                      background: off ? '#FDECEA' : '#DCFCE7',
                      color: off ? '#8E2F1F' : '#14532D',
                      borderColor: 'transparent',
                    }}
                  >
                    {off ? '✕' : '✓'} {prettyDate(d)}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        {remarkBox(key, 'Optional note for the student', a.remark ?? '')}
        <div style={{ display: 'flex', gap: '0.6rem', marginTop: '0.8rem', flexWrap: 'wrap' }}>
          {allOff ? (
            <button disabled={busy === key} onClick={() => saveAck(a, 'excused')}>
              Excuse classes again
            </button>
          ) : (
            <>
              <button disabled={busy === key || (!dirty && a.status !== 'pending')} onClick={() => saveAck(a, 'excused')}>
                {a.status === 'pending' ? 'Excuse classes' : 'Save changes'}
              </button>
              <button className="button-secondary" disabled={busy === key} onClick={() => saveAck(a, 'declined')}>
                Don't excuse any
              </button>
            </>
          )}
        </div>
      </div>
    );
  };

  const nothing = pendingCount + pendingAcks.length === 0;

  return (
    <div style={{ maxWidth: 760, margin: '0 auto', padding: '1rem 0 3rem' }}>
      <h1 style={{ fontSize: '1.5rem', margin: '0 0 0.3rem' }}>Medical Leaves</h1>
      <p style={{ color: 'var(--ink-soft)', margin: '0 0 1.2rem', fontSize: '0.9rem' }}>
        Doctor → Deputy Registrar → Dean → HOD. Once approved, the student's classes in those dates count as present; each teacher can
        still choose not to excuse their own classes. You only see the steps that are yours.
      </p>
      {error && <p className="error-text">{error}</p>}

      {ROLES.map((r) =>
        pending[r].length > 0 ? (
          <div key={r}>
            <p className="eyebrow">
              {ROLE_SECTION[r]} · {pending[r].length}
            </p>
            {pending[r].map((l) => leaveCard(l, r))}
          </div>
        ) : null,
      )}

      {pendingAcks.length > 0 && (
        <>
          <p className="eyebrow">Excuse missed classes · {pendingAcks.length}</p>
          {pendingAcks.map(ackCard)}
        </>
      )}

      {nothing && (
        <div className="card" style={{ padding: '1.6rem', textAlign: 'center', color: 'var(--ink-soft)' }}>
          Nothing waiting for you right now.
        </div>
      )}

      {recentAcks.length > 0 && (
        <>
          <p className="eyebrow" style={{ marginTop: '2rem' }}>Medical leave in your classes (last 30 days)</p>
          {recentAcks.map(ackCard)}
        </>
      )}

      {history.length > 0 && (
        <>
          <p className="eyebrow" style={{ marginTop: '2rem' }}>Already handled</p>
          <div className="card" style={{ padding: '0.4rem 1.4rem' }}>
            {history.map(({ leave: l, role }) => (
              <div key={l.id} style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', padding: '0.7rem 0', borderBottom: '1px solid var(--line)', flexWrap: 'wrap' }}>
                <span>
                  <strong>{l.studentName}</strong> · {l.fromDate} → {l.toDate}
                  <span style={{ color: 'var(--ink-soft)', fontSize: '0.8rem' }}> · you as {ROLE_LABEL[role]}</span>
                </span>
                <span style={{ color: l.stage === 'rejected' ? '#b42318' : 'var(--ink-soft)', fontSize: '0.85rem' }}>{stageLabel(l)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
