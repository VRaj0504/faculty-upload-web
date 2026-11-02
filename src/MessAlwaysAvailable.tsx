import { useEffect, useState } from 'react';
import { collection, deleteDoc, doc, getDocs, orderBy, query, setDoc, writeBatch } from 'firebase/firestore';
import { db } from './firebaseConfig';

type Item = { id: string; name: string; price: number | null; order: number };

const DEFAULTS = ['Idli', 'Paratha', 'Maggi', 'Thali', 'Chai'];

export default function MessAlwaysAvailable() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [draft, setDraft] = useState<Record<string, { name: string; price: string }>>({});
  const [newName, setNewName] = useState('');
  const [newPrice, setNewPrice] = useState('');
  const [status, setStatus] = useState('');

  const load = async () => {
    const snap = await getDocs(query(collection(db, 'messAlwaysAvailable'), orderBy('order', 'asc')));
    const list = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Item, 'id'>) }));
    setItems(list);
    setDraft(Object.fromEntries(list.map((i) => [i.id, { name: i.name, price: i.price == null ? '' : String(i.price) }])));
  };

  useEffect(() => {
    load().catch((e) => setStatus(`Couldn't load: ${e.message}`));
  }, []);

  const parsePrice = (p: string) => (p.trim() === '' ? null : Math.max(0, Math.round(Number(p))));

  const addDefaults = async () => {
    const b = writeBatch(db);
    DEFAULTS.forEach((name, i) => b.set(doc(collection(db, 'messAlwaysAvailable')), { name, price: null, order: i }));
    await b.commit();
    await load();
    setStatus('Added Idli, Paratha, Maggi, Thali and Chai. Set their prices below.');
  };

  const saveAll = async () => {
    if (!items) return;
    for (const i of items) {
      const d = draft[i.id];
      const price = parsePrice(d?.price ?? '');
      if (!d?.name.trim() || (price !== null && Number.isNaN(price))) {
        setStatus('Every item needs a name, and prices must be numbers.');
        return;
      }
    }
    const b = writeBatch(db);
    items.forEach((i, idx) => b.set(doc(db, 'messAlwaysAvailable', i.id), { name: draft[i.id].name.trim(), price: parsePrice(draft[i.id].price), order: idx }));
    await b.commit().then(() => setStatus('Saved. Students see the new prices right away.')).catch((e) => setStatus(`Couldn't save: ${e.message}`));
    await load();
  };

  const add = async () => {
    const price = parsePrice(newPrice);
    if (!newName.trim() || (price !== null && Number.isNaN(price))) return;
    await setDoc(doc(collection(db, 'messAlwaysAvailable')), { name: newName.trim(), price, order: items?.length ?? 0 });
    setNewName('');
    setNewPrice('');
    await load();
  };

  const remove = async (i: Item) => {
    if (!confirm(`Remove ${i.name}?`)) return;
    await deleteDoc(doc(db, 'messAlwaysAvailable', i.id));
    await load();
  };

  return (
    <div className="card" style={{ maxWidth: 760, margin: '1rem auto 1.5rem', padding: '1.2rem 1.4rem' }}>
      <h2 style={{ fontSize: '1.15rem', margin: '0 0 0.2rem' }}>Always available at the mess</h2>
      <p className="res-hint" style={{ marginTop: 0 }}>Shown under every day's menu in the app. Leave the price blank to show "Ask at counter".</p>
      {items === null ? (
        <p className="res-hint">Loading…</p>
      ) : items.length === 0 ? (
        <button onClick={addDefaults}>Add Idli, Paratha, Maggi, Thali, Chai</button>
      ) : (
        <>
          {items.map((i) => (
            <div key={i.id} className="att-row" style={{ alignItems: 'flex-end', marginTop: '0.5rem' }}>
              <div className="att-field">
                <label>Item</label>
                <input value={draft[i.id]?.name ?? ''} maxLength={40} onChange={(e) => setDraft((d) => ({ ...d, [i.id]: { ...d[i.id], name: e.target.value } }))} />
              </div>
              <div className="att-field" style={{ flex: '0 1 140px' }}>
                <label>Price (₹)</label>
                <input inputMode="numeric" value={draft[i.id]?.price ?? ''} onChange={(e) => setDraft((d) => ({ ...d, [i.id]: { ...d[i.id], price: e.target.value.replace(/[^0-9]/g, '') } }))} />
              </div>
              <button className="button-secondary" onClick={() => remove(i)}>Remove</button>
            </div>
          ))}
          <div className="att-row" style={{ alignItems: 'flex-end' }}>
            <div className="att-field">
              <label>Add an item</label>
              <input value={newName} maxLength={40} placeholder="e.g. Poha" onChange={(e) => setNewName(e.target.value)} />
            </div>
            <div className="att-field" style={{ flex: '0 1 140px' }}>
              <label>Price (₹)</label>
              <input inputMode="numeric" value={newPrice} onChange={(e) => setNewPrice(e.target.value.replace(/[^0-9]/g, ''))} />
            </div>
            <button className="button-secondary" disabled={!newName.trim()} onClick={add}>Add</button>
          </div>
          <div style={{ marginTop: '1rem', display: 'flex', gap: '0.6rem', alignItems: 'center' }}>
            <button onClick={saveAll}>Save prices</button>
          </div>
        </>
      )}
      {status && <p className="res-hint">{status}</p>}
    </div>
  );
}
