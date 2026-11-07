import { useEffect, useMemo, useState } from 'react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { db } from './firebaseConfig';

type Change = {
  id: string;
  date: string;
  branch: string;
  semester: number;
  section: string | null;
  subjectCode: string;
  subjectName: string;
  startTime: string;
  endTime: string;
  type: 'cancelled' | 'room';
  oldRoom: string | null;
  newRoom: string | null;
  facultyName: string;
};

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function to12h(t: string) {
  const m = /^(\d{1,2})[:.](\d{2})/.exec(t ?? '');
  if (!m) return t;
  const h = Number(m[1]);
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h >= 12 ? 'PM' : 'AM'}`;
}

function dayLabel(date: string) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
}

/** Read-only list of classes faculty cancelled or moved from the app. */
export default function ClassChanges() {
  const [rows, setRows] = useState<Change[] | null>(null);
  const [error, setError] = useState('');
  const [kind, setKind] = useState<'all' | 'cancelled' | 'room'>('all');
  const [branch, setBranch] = useState('all');
  const [showPast, setShowPast] = useState(false);
  const today = iso(new Date());
  const from = showPast ? iso(new Date(Date.now() - 30 * 86400000)) : today;

  useEffect(() => {
    setRows(null);
    return onSnapshot(
      query(collection(db, 'classChanges'), where('date', '>=', from)),
      (snap) => setRows(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Change, 'id'>) }))),
      (e) => {
        setError(e.message);
        setRows([]);
      },
    );
  }, [from]);

  const branches = useMemo(() => Array.from(new Set((rows ?? []).map((r) => r.branch))).sort(), [rows]);
  const shown = (rows ?? [])
    .filter((r) => (kind === 'all' || r.type === kind) && (branch === 'all' || r.branch === branch))
    .sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));

  return (
    <div>
      <div className="res-head">
        <div>
          <h1>Class changes</h1>
          <p>Classes faculty cancelled or moved to another room from the app. Students get a notification for each one.</p>
        </div>
      </div>
      <div className="card" style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <label>
          Type{' '}
          <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="all">All</option>
            <option value="cancelled">Cancelled</option>
            <option value="room">Room changed</option>
          </select>
        </label>
        <label>
          Branch{' '}
          <select value={branch} onChange={(e) => setBranch(e.target.value)}>
            <option value="all">All</option>
            {branches.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>
        <label>
          Show{' '}
          <select value={showPast ? 'past' : 'upcoming'} onChange={(e) => setShowPast(e.target.value === 'past')}>
            <option value="upcoming">Today and later</option>
            <option value="past">Last 30 days and later</option>
          </select>
        </label>
      </div>
      {error && <p className="error">{error}</p>}
      {rows === null ? (
        <p>Loading…</p>
      ) : shown.length === 0 ? (
        <div className="card">
          <p style={{ margin: 0 }}>No class changes {showPast ? 'in this period' : 'coming up'}.</p>
        </div>
      ) : (
        <div className="card" style={{ marginTop: '1rem' }}>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Time</th>
                <th>Class</th>
                <th>Subject</th>
                <th>Change</th>
                <th>By</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} style={r.date < today ? { opacity: 0.6 } : undefined}>
                  <td>{dayLabel(r.date)}</td>
                  <td>{to12h(r.startTime)}</td>
                  <td>
                    {r.branch} · Sem {r.semester}
                    {r.section ? ` · ${r.section}` : ''}
                  </td>
                  <td>{r.subjectName || r.subjectCode}</td>
                  <td>{r.type === 'cancelled' ? 'Cancelled' : `Room ${r.oldRoom ?? '?'} → ${r.newRoom ?? '?'}`}</td>
                  <td>{r.facultyName}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
