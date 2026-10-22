import { useEffect, useState } from 'react';
import { collection, doc, setDoc, deleteDoc, onSnapshot, serverTimestamp } from 'firebase/firestore';
import { db, auth } from './firebaseConfig';

type HolidayOverride = {
  date: string;
  name: string;
  addedByEmail?: string;
};

function AddHoliday() {
  const [date, setDate] = useState('');
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const [overrides, setOverrides] = useState<HolidayOverride[]>([]);

  useEffect(() => {
    const unsubscribe = onSnapshot(collection(db, 'holidayOverrides'), (snap) => {
      const list = snap.docs
        .map((d) => ({ date: d.id, name: d.data().name, addedByEmail: d.data().addedByEmail }))
        .sort((a, b) => a.date.localeCompare(b.date));
      setOverrides(list);
    });
    return () => unsubscribe();
  }, []);

  const handlePublish = async () => {
    if (!date || !name.trim()) {
      setStatus('Pick a date and type what the holiday is for.');
      return;
    }
    const existing = overrides.find((o) => o.date === date);
    if (existing && !confirm(`${date} is already set as "${existing.name}". Replace it with "${name.trim()}"?`)) {
      return;
    }
    setSaving(true);
    setStatus('');
    try {
      await setDoc(doc(db, 'holidayOverrides', date), {
        name: name.trim(),
        addedBy: auth.currentUser?.uid ?? null,
        addedByEmail: auth.currentUser?.email ?? null,
        addedAt: serverTimestamp(),
      });
      setDate('');
      setName('');
      setStatus(`Published — class reminders for ${date} will stop within a few minutes, and everyone gets a "Holiday today" push that morning.`);
    } catch (e: any) {
      setStatus(`Couldn't save: ${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async (d: string) => {
    if (!confirm(`Remove the holiday on ${d}? Class reminders for that date will resume.`)) return;
    try {
      await deleteDoc(doc(db, 'holidayOverrides', d));
    } catch (e: any) {
      alert(`Couldn't remove it: ${e.message}`);
    }
  };

  const today = new Date().toISOString().slice(0, 10);
  const upcoming = overrides.filter((o) => o.date >= today);
  const past = overrides.filter((o) => o.date < today);

  return (
    <div className="card" style={{ width: 640, maxWidth: '100%', padding: '2.5rem', margin: '3rem auto' }}>
      <h1 style={{ fontSize: '1.5rem' }}>Add a Holiday</h1>
      <p style={{ fontSize: '0.85rem', color: 'var(--ink-soft)' }}>
        For a holiday announced by email — like a Ganesh Visarjan circular — that isn't already on the app's fixed
        yearly calendar. Once published, class reminders stop for that date and everyone gets a holiday
        notification that morning instead. Only add this after reading the actual official announcement.
      </p>

      <label style={{ marginTop: '1.25rem', display: 'block' }}>Date</label>
      <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />

      <label style={{ marginTop: '1rem', display: 'block' }}>What's the occasion?</label>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="e.g. Ganesh Visarjan"
      />

      {status && <p style={{ marginTop: '1rem', fontSize: '0.9rem' }}>{status}</p>}

      <button onClick={handlePublish} disabled={saving} style={{ width: '100%', marginTop: '1.25rem' }}>
        {saving ? 'Saving…' : 'Publish Holiday'}
      </button>

      {upcoming.length > 0 && (
        <>
          <h2 style={{ fontSize: '1.05rem', marginTop: '2rem' }}>Upcoming</h2>
          {upcoming.map((o) => (
            <div key={o.date} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.6rem 0', borderBottom: '1px solid var(--rule, #e5e5e5)' }}>
              <div>
                <strong>{o.date}</strong> — {o.name}
                {o.addedByEmail && <span style={{ fontSize: '0.75rem', color: 'var(--ink-soft)' }}> · added by {o.addedByEmail}</span>}
              </div>
              <button onClick={() => handleRemove(o.date)} className="button-secondary" style={{ fontSize: '0.78rem', padding: '0.2rem 0.6rem' }}>
                Remove
              </button>
            </div>
          ))}
        </>
      )}

      {past.length > 0 && (
        <>
          <h2 style={{ fontSize: '1.05rem', marginTop: '2rem', color: 'var(--ink-soft)' }}>Past</h2>
          {past.map((o) => (
            <div key={o.date} style={{ padding: '0.4rem 0', fontSize: '0.85rem', color: 'var(--ink-soft)' }}>
              {o.date} — {o.name}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

export default AddHoliday;
