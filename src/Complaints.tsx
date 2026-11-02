import { useEffect, useState } from 'react';
import { collection, query, where, orderBy, limit, onSnapshot, getDocs, getDoc, doc, updateDoc, serverTimestamp, Timestamp, type Query } from 'firebase/firestore';
import { auth, db } from './firebaseConfig';

type IssueType = 'complaint' | 'doubt';
type Complaint = {
  id: string;
  studentUid: string;
  studentName: string;
  studentEnrollmentNumber?: string;

  type?: IssueType;
  category: 'Facilities' | 'Harassment' | 'Academic' | 'Other' | 'Coursework' | 'Exam';
  facultyEmail?: string | null;
  facultyName?: string | null;
  subject: string;
  description: string;
  status: 'pending' | 'resolved' | 'rejected';
  facultyRemark: string | null;
  createdAt: Timestamp | null;

  resolvedAt?: Timestamp | null;
  resolvedByName?: string | null;
};

const STATUS_BG: Record<Complaint['status'], string> = {
  pending: '#fef9c3',
  resolved: '#dcfce7',
  rejected: '#fee2e2',
};

function monthOptions(): { value: string; label: string }[] {

  const opts: { value: string; label: string }[] = [];
  const now = new Date();
  for (let i = 0; i < 24; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const label = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    opts.push({ value, label });
  }
  return opts;
}

async function exportMonthToExcel(monthValue: string, monthLabel: string, isAdmin: boolean, visible: Complaint[]) {
  const [year, month] = monthValue.split('-').map(Number);
  const start = Timestamp.fromDate(new Date(year, month - 1, 1));
  const end = Timestamp.fromDate(new Date(year, month, 1));

  let rows: Complaint[];
  if (isAdmin) {
    const q = query(
      collection(db, 'complaints'),
      where('type', '==', 'complaint'),
      where('createdAt', '>=', start),
      where('createdAt', '<', end),
      orderBy('createdAt', 'asc'),
    );
    const snap = await getDocs(q);
    rows = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Complaint, 'id'>) }));
  } else {
    rows = visible
      .filter((c) => (c.type ?? 'complaint') === 'complaint')
      .filter((c) => c.createdAt && c.createdAt.toMillis() >= start.toMillis() && c.createdAt.toMillis() < end.toMillis())
      .sort((a, b) => (a.createdAt?.toMillis() ?? 0) - (b.createdAt?.toMillis() ?? 0));
  }

  const fmt = (t?: Timestamp | null) => (t ? t.toDate().toLocaleString('en-IN') : '');
  const sheetData = rows.map((c) => ({
    'Date Filed': fmt(c.createdAt),
    'Student Name': c.studentName,
    'Enrollment No.': c.studentEnrollmentNumber ?? '',
    Category: c.category,
    Subject: c.subject,
    Description: c.description,
    'Addressed To': c.facultyName || 'Complaints committee',
    Status: c.status,
    'Resolved/Rejected By': c.resolvedByName ?? '',
    'Resolution Remark': c.facultyRemark ?? '',
    'Resolved/Rejected On': fmt(c.resolvedAt),
  }));

  const XLSX = await import('xlsx');
  const worksheet = XLSX.utils.json_to_sheet(sheetData.length ? sheetData : [{ 'No complaints filed this month': '' }]);
  worksheet['!cols'] = [
    { wch: 18 }, { wch: 22 }, { wch: 14 }, { wch: 14 }, { wch: 28 }, { wch: 40 },
    { wch: 22 }, { wch: 12 }, { wch: 20 }, { wch: 32 }, { wch: 18 },
  ];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Complaints');
  XLSX.writeFile(workbook, `Complaints - ${monthLabel.replace(' ', ' ')}.xlsx`);
  return rows.length;
}

const shortDate = (t?: Timestamp | null) => (t ? t.toDate().toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '');

function progressLine(item: Complaint): string {
  const filed = item.createdAt;
  if (!filed) return '';
  if (item.status === 'pending') {
    const days = Math.floor((Date.now() - filed.toMillis()) / 86400000);
    return `Filed ${shortDate(filed)} · ${days === 0 ? 'today' : `waiting ${days} day${days === 1 ? '' : 's'}`}`;
  }
  const took = item.resolvedAt ? Math.max(0, Math.round((item.resolvedAt.toMillis() - filed.toMillis()) / 86400000)) : null;
  return `Filed ${shortDate(filed)} · ${item.status === 'resolved' ? 'Resolved' : 'Rejected'}${item.resolvedByName ? ` by ${item.resolvedByName}` : ''}${item.resolvedAt ? ` on ${shortDate(item.resolvedAt)}` : ''}${took !== null ? ` (${took === 0 ? 'same day' : `${took} day${took === 1 ? '' : 's'}`})` : ''}`;
}

function ComplaintCard({
  item,
  busy,
  onResolve,
  canAct,
}: {
  item: Complaint;
  busy: boolean;
  onResolve: (item: Complaint, status: 'resolved' | 'rejected', remark: string) => void;
  canAct: boolean;
}) {
  const [remark, setRemark] = useState('');
  return (
    <div className="card" style={{ marginTop: '1.2rem', padding: '1.4rem 1.6rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span
              className="eyebrow"
              style={{
                fontSize: '0.6rem',
                padding: '0.1rem 0.4rem',
                borderRadius: 5,
                backgroundColor: (item.type ?? 'complaint') === 'doubt' ? '#dbeafe' : '#ffe4d6',
              }}
            >
              {(item.type ?? 'complaint') === 'doubt' ? 'Doubt' : 'Complaint'}
            </span>
            <div style={{ fontWeight: 600 }}>{item.subject}</div>
          </div>
          <div className="eyebrow" style={{ fontSize: '0.7rem', marginTop: '0.2rem' }}>
            {item.category} · {item.studentName}
            {item.studentEnrollmentNumber ? ` (${item.studentEnrollmentNumber})` : ''}
          </div>
          <div style={{ fontSize: '0.78rem', fontStyle: 'italic', color: 'var(--ink-soft)', marginTop: '0.15rem' }}>
            {item.facultyName ? `To: ${item.facultyName}` : 'To: Any faculty / admin'}
          </div>
        </div>
        <span
          className="eyebrow"
          style={{
            fontSize: '0.65rem',
            padding: '0.2rem 0.5rem',
            borderRadius: 6,
            backgroundColor: STATUS_BG[item.status],
          }}
        >
          {item.status}
        </span>
      </div>

      <p style={{ fontSize: '0.9rem', marginTop: '0.6rem', whiteSpace: 'pre-wrap' }}>{item.description}</p>
      <p style={{ fontSize: '0.78rem', color: 'var(--ink-soft)', fontWeight: 600, marginTop: '0.5rem' }}>{progressLine(item)}</p>

      {item.status === 'pending' && !canAct ? null : item.status === 'pending' ? (
        <>
          <input
            style={{ marginTop: '0.6rem' }}
            value={remark}
            onChange={(e) => setRemark(e.target.value)}
            placeholder="Optional remark"
          />
          <div style={{ display: 'flex', gap: '0.8rem', marginTop: '0.8rem' }}>
            <button onClick={() => onResolve(item, 'resolved', remark)} disabled={busy} style={{ flex: 1 }}>
              {busy ? 'Updating…' : (item.type ?? 'complaint') === 'doubt' ? 'Mark Answered' : 'Mark Resolved'}
            </button>
            <button
              onClick={() => onResolve(item, 'rejected', remark)}
              disabled={busy}
              className="button-secondary"
              style={{ flex: 1 }}
            >
              {(item.type ?? 'complaint') === 'doubt' ? 'Dismiss' : 'Reject'}
            </button>
          </div>
        </>
      ) : (
        item.facultyRemark && (
          <p style={{ fontSize: '0.85rem', marginTop: '0.6rem', fontStyle: 'italic' }}>
            Remark: {item.facultyRemark}
          </p>
        )
      )}
    </div>
  );
}

type TypeFilter = 'all' | IssueType;

type StatusFilter = 'all' | Complaint['status'];

function Complaints({ email, isAdmin, isLeader = false }: { email: string; isAdmin: boolean; isLeader?: boolean }) {
  const [complaints, setComplaints] = useState<Complaint[]>([]);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const months = monthOptions();
  const [exportMonth, setExportMonth] = useState(months[0].value);
  const [exporting, setExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState('');
  const [committee, setCommittee] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  useEffect(() => {
    const parts = new Map<string, Complaint[]>();
    const failed = new Set<string>();
    const emit = () => {
      const byId = new Map<string, Complaint>();
      parts.forEach((list) => list.forEach((c) => byId.set(c.id, c)));
      setComplaints(
        Array.from(byId.values())
          .sort((a, b) => (b.createdAt?.toMillis() ?? 0) - (a.createdAt?.toMillis() ?? 0))
          .slice(0, 500),
      );
      setError(failed.size ? 'Some complaints could not be loaded. Check the browser console (F12) for details.' : '');
    };
    const listen = (key: string, q: Query) =>
      onSnapshot(
        q,
        (snapshot) => {
          failed.delete(key);
          parts.set(key, snapshot.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Complaint, 'id'>) })));
          emit();
        },
        (err) => {
          console.error(`Complaints query (${key}) failed:`, err);
          failed.add(key);
          emit();
        },
      );

    const me = email.toLowerCase();
    const unsubs: (() => void)[] = [];
    let stopped = false;
    const isCommittee = isAdmin
      ? Promise.resolve(true)
      : getDoc(doc(db, 'config', 'complaints'))
          .then((snap) => ((snap.data() as { committeeEmails?: string[] } | undefined)?.committeeEmails ?? []).map((e) => e.toLowerCase()).includes(me))
          .catch(() => false);
    isCommittee.then((member) => {
      if (stopped) return;
      setCommittee(member);
      if (member || isLeader) {
        unsubs.push(listen('all', query(collection(db, 'complaints'), orderBy('createdAt', 'desc'), limit(500))));
        return;
      }
      unsubs.push(
        listen('mine', query(collection(db, 'complaints'), where('facultyEmail', '==', me))),
        listen('openDoubts', query(collection(db, 'complaints'), where('facultyEmail', '==', null), where('type', '==', 'doubt'))),
      );
    });
    return () => {
      stopped = true;
      unsubs.forEach((u) => u());
    };
  }, [email, isAdmin, isLeader]);

  const handleResolve = async (item: Complaint, status: 'resolved' | 'rejected', remark: string) => {
    setBusyId(item.id);
    try {
      await updateDoc(doc(db, 'complaints', item.id), {
        status,
        resolvedAt: serverTimestamp(),
        resolvedBy: auth.currentUser?.uid,
        resolvedByName: auth.currentUser?.displayName ?? 'Faculty',
        facultyRemark: remark.trim() || null,
      });
    } catch (err: any) {
      alert(`Could not update: ${err.message}`);
    } finally {
      setBusyId(null);
    }
  };

  const handleExport = async () => {
    const label = months.find((m) => m.value === exportMonth)?.label ?? exportMonth;
    setExporting(true);
    setExportStatus('');
    try {
      const count = await exportMonthToExcel(exportMonth, label, isAdmin || isLeader || committee, complaints);
      setExportStatus(count > 0 ? `Downloaded ${count} complaint(s) from ${label}.` : `No complaints were filed in ${label}.`);
    } catch (err: any) {
      setExportStatus(`Export failed: ${err.message}`);
    } finally {
      setExporting(false);
    }
  };

  const byType = typeFilter === 'all' ? complaints : complaints.filter((c) => (c.type ?? 'complaint') === typeFilter);
  const filtered = statusFilter === 'all' ? byType : byType.filter((c) => c.status === statusFilter);
  const counts = {
    all: byType.length,
    pending: byType.filter((c) => c.status === 'pending').length,
    resolved: byType.filter((c) => c.status === 'resolved').length,
    rejected: byType.filter((c) => c.status === 'rejected').length,
  };
  const canAct = isAdmin || committee || !isLeader;
  const pending = filtered.filter((c) => c.status === 'pending');
  const resolved = filtered.filter((c) => c.status !== 'pending');
  const ordered = [...pending, ...resolved];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '2rem 0' }}>
      <div className="card" style={{ width: 640, padding: '2rem 2.5rem' }}>
        <h1 style={{ fontSize: '1.5rem' }}>Complaints & Doubts</h1>
        <p style={{ color: 'var(--ink-soft)', fontSize: '0.9rem' }}>
          General student complaints — facilities, harassment, academic issues — and academic doubts students had
          nowhere else to ask. Every faculty account sees every item here; this isn't addressed to one specific
          person the way leave requests are.
        </p>

        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
          {((['all', 'complaint', 'doubt'] as TypeFilter[])).map((f) => (
            <button
              key={f}
              onClick={() => setTypeFilter(f)}
              className={typeFilter === f ? undefined : 'button-secondary'}
              style={{ padding: '0.35rem 0.9rem', fontSize: '0.82rem' }}
            >
              {f === 'all' ? 'All' : f === 'complaint' ? 'Complaints' : 'Doubts'}
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.6rem', flexWrap: 'wrap' }}>
          {(['all', 'pending', 'resolved', 'rejected'] as StatusFilter[]).map((f) => (
            <button
              key={f}
              onClick={() => setStatusFilter(f)}
              className={statusFilter === f ? undefined : 'button-secondary'}
              style={{ padding: '0.35rem 0.9rem', fontSize: '0.82rem' }}
            >
              {f === 'all' ? 'Any status' : f === 'pending' ? 'Open' : f === 'resolved' ? 'Resolved' : 'Rejected'} · {counts[f]}
            </button>
          ))}
        </div>

        {isLeader && !isAdmin && (
          <p style={{ fontSize: '0.8rem', color: 'var(--ink-soft)', marginTop: '0.8rem', background: 'var(--panel-bg)', borderRadius: 10, padding: '0.55rem 0.75rem' }}>
            You can see every complaint and how it is progressing. Resolving them is left to the complaints committee and faculty it is addressed to.
          </p>
        )}

        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <select value={exportMonth} onChange={(e) => setExportMonth(e.target.value)} style={{ width: 'auto' }}>
            {months.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
          <button onClick={handleExport} disabled={exporting} className="button-secondary">
            {exporting ? 'Preparing…' : '⬇ Download Complaints (Excel)'}
          </button>
        </div>
        {exportStatus && <p style={{ fontSize: '0.82rem', color: 'var(--ink-soft)', marginTop: '0.4rem' }}>{exportStatus}</p>}
        <p style={{ fontSize: '0.75rem', color: 'var(--ink-soft)', marginTop: '0.2rem' }}>
          Complaints only — doubts aren't included, since resolved ones are deleted automatically after 12 hours.
        </p>

        {error && <p className="error-text" style={{ marginTop: '1rem' }}>{error}</p>}
        {!error && ordered.length === 0 && (
          <p style={{ color: 'var(--ink-soft)', marginTop: '1rem' }}>
            {statusFilter !== 'all' ? 'Nothing here with that status.' : typeFilter === 'all' ? 'Nothing submitted yet.' : `No ${typeFilter}s submitted yet.`}
          </p>
        )}

        {ordered.map((item) => (
          <ComplaintCard key={item.id} item={item} busy={busyId === item.id} onResolve={handleResolve} canAct={canAct} />
        ))}
      </div>
    </div>
  );
}

export default Complaints;
