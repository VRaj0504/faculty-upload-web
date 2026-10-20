import { useEffect, useState } from 'react';
import { collection, deleteDoc, doc, onSnapshot, orderBy, query, Timestamp, updateDoc } from 'firebase/firestore';
import { auth, db } from './firebaseConfig';

// Student reports on Lost & Found posts (filed from the app's flag button).
// Faculty either remove the post or dismiss the report.
type Report = {
  id: string;
  itemId: string;
  itemTitle: string;
  postedBy: string;
  postedByName: string;
  reason: string;
  reporterName: string;
  status: 'open' | 'removed' | 'dismissed';
  createdAt: Timestamp | null;
};

export default function Reports() {
  const [rows, setRows] = useState<Report[] | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const q = query(collection(db, 'reports'), orderBy('createdAt', 'desc'));
    return onSnapshot(
      q,
      (s) => setRows(s.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Report, 'id'>) }))),
      (e) => {
        setError(e.message);
        setRows([]);
      },
    );
  }, []);

  const close = async (r: Report, status: 'removed' | 'dismissed') => {
    setBusy(r.id);
    setError('');
    try {
      if (status === 'removed') {
        // Already deleted by someone else is fine.
        await deleteDoc(doc(db, 'lostFoundItems', r.itemId)).catch(() => {});
      }
      await updateDoc(doc(db, 'reports', r.id), {
        status,
        closedBy: auth.currentUser?.displayName ?? auth.currentUser?.email ?? 'Faculty',
      });
    } catch (e: any) {
      setError(e?.message ?? 'Could not update the report.');
    } finally {
      setBusy('');
    }
  };

  if (rows === null) return <p style={{ padding: '1rem' }}>Loading…</p>;
  const shown = rows.filter((r) => showClosed || r.status === 'open');

  return (
    <div style={{ padding: '1rem', maxWidth: 760 }}>
      <h2 style={{ marginTop: 0 }}>Reported posts</h2>
      <p style={{ color: '#64748b', marginTop: 0 }}>
        Students flag Lost &amp; Found posts from the app. Remove a post that breaks the rules, or dismiss a report that doesn't.
      </p>
      <label style={{ display: 'block', margin: '0.5rem 0 1rem' }}>
        <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} /> Show closed reports
      </label>
      {error && <p style={{ color: '#b91c1c' }}>{error}</p>}
      {shown.length === 0 && <p>No {showClosed ? '' : 'open '}reports. 🎉</p>}
      {shown.map((r) => (
        <div key={r.id} style={{ border: '1px solid #e2e8f0', borderRadius: 12, padding: '0.9rem', marginBottom: '0.7rem', background: '#fff' }}>
          <strong>{r.itemTitle}</strong>
          <div style={{ color: '#475569', fontSize: 14, marginTop: 4 }}>
            Posted by {r.postedByName} · reported by {r.reporterName}
            {r.createdAt ? ` · ${r.createdAt.toDate().toLocaleString('en-IN')}` : ''}
          </div>
          <div style={{ marginTop: 6 }}>Reason: <b>{r.reason}</b></div>
          {r.status === 'open' ? (
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button type="button" disabled={busy === r.id} onClick={() => close(r, 'removed')}>Remove post</button>
              <button type="button" disabled={busy === r.id} onClick={() => close(r, 'dismissed')}>Dismiss report</button>
            </div>
          ) : (
            <div style={{ marginTop: 8, color: '#64748b' }}>{r.status === 'removed' ? 'Post removed' : 'Dismissed'}</div>
          )}
        </div>
      ))}
    </div>
  );
}
