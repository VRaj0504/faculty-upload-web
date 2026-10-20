import { useEffect, useState } from 'react';
import { collection, query, where, orderBy, limit, onSnapshot, getDocs, doc, updateDoc, serverTimestamp, Timestamp } from 'firebase/firestore';
import { auth, db } from './firebaseConfig';

// Mirrors the mobile app's src/screens/ComplaintsScreen.tsx and
// src/firebase/complaintService.ts exactly — same collection, same field
// names — so resolving a complaint from here triggers
// sendComplaintResolutionPush (already deployed) the same way resolving
// it from the mobile app would.
type IssueType = 'complaint' | 'doubt';
type Complaint = {
  id: string;
  studentUid: string;
  studentName: string;
  studentEnrollmentNumber?: string;
  // Missing on docs written before this field existed — read as
  // "complaint" wherever it's used below, never left undefined.
  type?: IssueType;
  category: 'Facilities' | 'Harassment' | 'Academic' | 'Other' | 'Coursework' | 'Exam';
  facultyEmail?: string | null;
  facultyName?: string | null;
  subject: string;
  description: string;
  status: 'pending' | 'resolved' | 'rejected';
  facultyRemark: string | null;
  createdAt: Timestamp | null;
  // Set by handleResolve below — declared here now because the Excel
  // report needs them; previously omitted even though every resolved
  // doc has always carried them.
  resolvedAt?: Timestamp | null;
  resolvedByName?: string | null;
};

const STATUS_BG: Record<Complaint['status'], string> = {
  pending: '#fef9c3',
  resolved: '#dcfce7',
  rejected: '#fee2e2',
};

function monthOptions(): { value: string; label: string }[] {
  // Last 24 months, newest first — plenty of runway without the list
  // growing unbounded; complaints are meant to be exported and kept
  // externally, not browsed here indefinitely.
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

// Complaints only — never doubts. Doubts are meant to disappear (see
// cleanupResolvedDoubts, the Cloud Function that deletes a resolved one
// after 12h); a monthly record of who complained about what and how it
// was resolved is the whole point of this button, so pulling in doubts
// would defeat their own cleanup by keeping a permanent copy here.
//
// A dedicated query scoped to the chosen month, not the capped
// 500-live-doc listener already on screen — that listener exists to
// keep today's working queue fast, not to be a reliable source for a
// month that might be well outside its most-recent-500 window.
async function exportMonthToExcel(monthValue: string, monthLabel: string) {
  const [year, month] = monthValue.split('-').map(Number);
  const start = Timestamp.fromDate(new Date(year, month - 1, 1));
  const end = Timestamp.fromDate(new Date(year, month, 1));

  const q = query(
    collection(db, 'complaints'),
    where('type', '==', 'complaint'),
    where('createdAt', '>=', start),
    where('createdAt', '<', end),
    orderBy('createdAt', 'asc'),
  );
  const snap = await getDocs(q);
  const rows = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Complaint, 'id'>) }));

  const fmt = (t?: Timestamp | null) => (t ? t.toDate().toLocaleString('en-IN') : '');
  const sheetData = rows.map((c) => ({
    'Date Filed': fmt(c.createdAt),
    'Student Name': c.studentName,
    'Enrollment No.': c.studentEnrollmentNumber ?? '',
    Category: c.category,
    Subject: c.subject,
    Description: c.description,
    'Addressed To': c.facultyName || 'Any faculty / admin',
    Status: c.status,
    'Resolved/Rejected By': c.resolvedByName ?? '',
    'Resolution Remark': c.facultyRemark ?? '',
    'Resolved/Rejected On': fmt(c.resolvedAt),
  }));

  // Loaded on demand, same as every other xlsx use in this app — no
  // reason to ship this ~500KB library to every faculty account that
  // never opens this tab.
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

// The remark draft lives here (local state), not in a shared map keyed
// by id on the parent — same fix and same reasoning as the mobile app's
// ComplaintsScreen.tsx: a shared map meant every keystroke into any one
// card's remark box re-rendered every card in the list, not just the one
// being typed into.
function ComplaintCard({
  item,
  busy,
  onResolve,
}: {
  item: Complaint;
  busy: boolean;
  onResolve: (item: Complaint, status: 'resolved' | 'rejected', remark: string) => void;
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

      {item.status === 'pending' ? (
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

function Complaints() {
  const [complaints, setComplaints] = useState<Complaint[]>([]);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const months = monthOptions();
  const [exportMonth, setExportMonth] = useState(months[0].value);
  const [exporting, setExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState('');

  useEffect(() => {
    // Same 500-doc cap as the mobile app's complaintService.ts
    // subscribeToAllComplaints — without it, this listener re-syncs
    // every complaint ever filed, forever, to every faculty account
    // that opens this tab.
    const q = query(collection(db, 'complaints'), orderBy('createdAt', 'desc'), limit(500));
    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        setError('');
        setComplaints(snapshot.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Complaint, 'id'>) })));
      },
      (err) => {
        console.error('Complaints query failed:', err);
        setError('Could not load complaints. Check the browser console (F12) for details.');
      },
    );
    return () => unsubscribe();
  }, []);

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
      const count = await exportMonthToExcel(exportMonth, label);
      setExportStatus(count > 0 ? `Downloaded ${count} complaint(s) from ${label}.` : `No complaints were filed in ${label}.`);
    } catch (err: any) {
      setExportStatus(`Export failed: ${err.message}`);
    } finally {
      setExporting(false);
    }
  };

  const filtered = typeFilter === 'all' ? complaints : complaints.filter((c) => (c.type ?? 'complaint') === typeFilter);
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
            {typeFilter === 'all' ? 'Nothing submitted yet.' : `No ${typeFilter}s submitted yet.`}
          </p>
        )}

        {ordered.map((item) => (
          <ComplaintCard key={item.id} item={item} busy={busyId === item.id} onResolve={handleResolve} />
        ))}
      </div>
    </div>
  );
}

export default Complaints;
