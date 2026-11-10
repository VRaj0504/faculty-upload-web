import { useEffect, useState } from 'react';
import { doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore';
import { auth, db } from './firebaseConfig';

// The weekly lunch menu students see in the app (Mess Menu screen and "Today's lunch" on Home).
// Saved at config/messMenu. Until it is saved once, the app shows the menu built into it.

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'] as const;
type Day = (typeof DAYS)[number];

const BUILT_IN: Record<Day, string[]> = {
  Monday: ['Kadhai Paneer/Butter Paneer Masala', 'Steam Rice', 'Tuver Dal', 'Chapati', 'Salad & Pickle', 'Chaas'],
  Tuesday: ['Bhindi Masala', 'Chana Dal', 'Jeera Rice', 'Paratha', 'Salad & Pickle', 'Curd'],
  Wednesday: ['Chole(Kabuli Chana)', 'Pulao', 'Poori', 'Salad & Pickle', 'Sweet(Gulab Jamun)'],
  Thursday: ['Dum Aloo', 'Jeera Rice', 'Kadhi', 'Salad & Pickle', 'Chapati'],
  Friday: ['Mix Vegetable', 'Matar Rice', 'Rajma', 'Chapati', 'Salad & Pickle', 'Chaas'],
};

const toText = (items: string[]) => items.join('\n');
const toItems = (text: string) =>
  text
    .split('\n')
    .map((s) => s.trim().slice(0, 60))
    .filter(Boolean)
    .slice(0, 20);

export default function MessMenuEditor({ canEdit }: { canEdit: boolean }) {
  const [text, setText] = useState<Record<Day, string> | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  useEffect(() => {
    getDoc(doc(db, 'config', 'messMenu'))
      .then((snap) => {
        const days = (snap.data()?.days ?? []) as { day?: string; lunch?: string[] }[];
        const next = {} as Record<Day, string>;
        DAYS.forEach((d) => {
          const found = days.find((x) => String(x?.day ?? '').toLowerCase() === d.toLowerCase());
          next[d] = toText(snap.exists() && Array.isArray(found?.lunch) ? found!.lunch! : BUILT_IN[d]);
        });
        setSaved(snap.exists());
        setText(next);
      })
      .catch((e) => setStatus(`Couldn't load the menu: ${e.message}`));
  }, []);

  const save = async () => {
    if (!text) return;
    const days = DAYS.map((d) => ({ day: d, lunch: toItems(text[d]) }));
    if (days.every((d) => d.lunch.length === 0)) {
      setStatus('Add at least one dish before saving.');
      return;
    }
    setBusy(true);
    try {
      await setDoc(doc(db, 'config', 'messMenu'), { days, updatedAt: serverTimestamp(), updatedBy: auth.currentUser?.email ?? '' });
      setSaved(true);
      setStatus('Saved. Students see the new menu right away.');
    } catch (e) {
      setStatus(`Couldn't save: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ maxWidth: 760, margin: '1rem auto 1.5rem', padding: '1.2rem 1.4rem' }}>
      <h2 style={{ fontSize: '1.15rem', margin: '0 0 0.2rem' }}>Weekly lunch menu</h2>
      <p className="res-hint" style={{ marginTop: 0 }}>
        One dish per line. Students see this in the app's Mess Menu, and today's lunch on their Home screen.
        {!saved && text ? ' This is the menu built into the app; save to start editing it from here.' : ''}
      </p>
      {text === null ? (
        <p className="res-hint">{status || 'Loading…'}</p>
      ) : (
        <>
          {DAYS.map((d) => (
            <div key={d} className="att-field" style={{ marginTop: '0.7rem' }}>
              <label htmlFor={`mess-${d}`}>{d}</label>
              <textarea
                id={`mess-${d}`}
                rows={Math.max(4, text[d].split('\n').length)}
                value={text[d]}
                disabled={!canEdit}
                onChange={(e) => setText((t) => (t ? { ...t, [d]: e.target.value } : t))}
                style={{ width: '100%', resize: 'vertical', font: 'inherit' }}
              />
            </div>
          ))}
          {canEdit ? (
            <div style={{ marginTop: '1rem' }}>
              <button onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save menu'}</button>
            </div>
          ) : (
            <p className="res-hint">Only admins can change the menu.</p>
          )}
          {status && <p className="res-hint">{status}</p>}
        </>
      )}
    </div>
  );
}
