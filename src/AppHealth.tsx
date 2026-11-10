import { useEffect, useMemo, useState } from 'react';
import { collection, documentId, getDocs, limit, orderBy, query, where } from 'firebase/firestore';
import { db } from './firebaseConfig';

// Admin page: how much the student app is used (from usageDaily) and the latest crash reports
// (from clientErrors). Both are written by the app itself; nothing here changes any data.

const RANGES = [7, 14, 30] as const;
type Day = { id: string; opens: number; screens: Record<string, number> };
type Crash = { id: string; message: string; where: string; screen: string; platform: string; appVersion: string; at: Date | null; stack: string };

const istDay = (daysAgo: number) => new Date(Date.now() + 5.5 * 3600 * 1000 - daysAgo * 86400000).toISOString().slice(0, 10);
const shortDay = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

export default function AppHealth() {
  const [range, setRange] = useState<(typeof RANGES)[number]>(14);
  const [days, setDays] = useState<Day[] | null>(null);
  const [crashes, setCrashes] = useState<Crash[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    setDays(null);
    setErr('');
    getDocs(query(collection(db, 'usageDaily'), where(documentId(), '>=', istDay(range - 1))))
      .then((snap) => setDays(snap.docs.map((d) => ({ id: d.id, opens: Number(d.data().opens ?? 0), screens: (d.data().screens ?? {}) as Record<string, number> }))))
      .catch((e) => setErr(`Couldn't load usage: ${e.message}`));
  }, [range]);

  useEffect(() => {
    getDocs(query(collection(db, 'clientErrors'), orderBy('at', 'desc'), limit(50)))
      .then((snap) =>
        setCrashes(
          snap.docs.map((d) => {
            const x = d.data();
            return {
              id: d.id,
              message: String(x.message ?? ''),
              where: String(x.where ?? ''),
              screen: String(x.screen ?? ''),
              platform: String(x.platform ?? ''),
              appVersion: String(x.appVersion ?? ''),
              stack: String(x.stack ?? ''),
              at: x.at?.toDate ? x.at.toDate() : null,
            };
          }),
        ),
      )
      .catch((e) => setErr(`Couldn't load crash reports: ${e.message}`));
  }, []);

  const totals = useMemo(() => {
    const screens: Record<string, number> = {};
    let opens = 0;
    (days ?? []).forEach((d) => {
      opens += d.opens;
      Object.entries(d.screens).forEach(([k, n]) => (screens[k] = (screens[k] ?? 0) + Number(n)));
    });
    const list = Object.entries(screens).sort((a, b) => b[1] - a[1]);
    return { opens, views: list.reduce((n, [, v]) => n + v, 0), list };
  }, [days]);

  const maxOpens = Math.max(1, ...(days ?? []).map((d) => d.opens));
  const maxViews = Math.max(1, ...totals.list.map(([, n]) => n));
  const bar = (value: number, max: number) => ({ width: `${Math.max(2, Math.round((value / max) * 100))}%`, height: 8, borderRadius: 999, background: 'var(--tone-blue-fg)' });

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
        <div>
          <h1 style={{ fontSize: '1.4rem', margin: 0 }}>App health</h1>
          <p className="res-hint" style={{ margin: '0.2rem 0 0' }}>How much the student app is used, and any crashes it reported.</p>
        </div>
        <div className="att-field" style={{ flex: '0 0 auto' }}>
          <label htmlFor="ah-range">Period</label>
          <select id="ah-range" value={range} onChange={(e) => setRange(Number(e.target.value) as (typeof RANGES)[number])}>
            {RANGES.map((r) => (
              <option key={r} value={r}>Last {r} days</option>
            ))}
          </select>
        </div>
      </div>
      {err && <p className="error-text">{err}</p>}

      <div className="card" style={{ padding: '1.2rem 1.4rem', marginBottom: '1rem' }}>
        <h2 style={{ fontSize: '1.05rem', margin: '0 0 0.2rem' }}>App opens per day</h2>
        {days === null ? (
          <p className="res-hint">Loading…</p>
        ) : days.length === 0 ? (
          <p className="res-hint">Nothing recorded in this period yet. Counts start once students are on the latest app version.</p>
        ) : (
          <>
            <p className="res-hint" style={{ marginTop: 0 }}>{totals.opens} opens and {totals.views} screen views in the last {range} days.</p>
            {days.map((d) => (
              <div key={d.id} style={{ display: 'grid', gridTemplateColumns: '5.5rem 1fr 3rem', alignItems: 'center', gap: '0.6rem', padding: '0.2rem 0' }}>
                <span style={{ fontSize: '0.85rem', color: 'var(--ink-soft)' }}>{shortDay(d.id)}</span>
                <div style={{ background: 'var(--panel-bg)', borderRadius: 999 }}><div style={bar(d.opens, maxOpens)} /></div>
                <span style={{ fontSize: '0.85rem', fontWeight: 700, textAlign: 'right' }}>{d.opens}</span>
              </div>
            ))}
          </>
        )}
      </div>

      <div className="card" style={{ padding: '1.2rem 1.4rem', marginBottom: '1rem' }}>
        <h2 style={{ fontSize: '1.05rem', margin: '0 0 0.6rem' }}>Most used screens</h2>
        {days === null ? (
          <p className="res-hint">Loading…</p>
        ) : totals.list.length === 0 ? (
          <p className="res-hint">No screen views recorded yet.</p>
        ) : (
          totals.list.slice(0, 15).map(([name, n]) => (
            <div key={name} style={{ display: 'grid', gridTemplateColumns: '10rem 1fr 3.5rem', alignItems: 'center', gap: '0.6rem', padding: '0.2rem 0' }}>
              <span style={{ fontSize: '0.88rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
              <div style={{ background: 'var(--panel-bg)', borderRadius: 999 }}><div style={bar(n, maxViews)} /></div>
              <span style={{ fontSize: '0.85rem', fontWeight: 700, textAlign: 'right' }}>{n}</span>
            </div>
          ))
        )}
      </div>

      <div className="card" style={{ padding: '1.2rem 1.4rem' }}>
        <h2 style={{ fontSize: '1.05rem', margin: '0 0 0.2rem' }}>Crash reports</h2>
        <p className="res-hint" style={{ marginTop: 0 }}>The latest 50. Reports are removed on their own after 30 days.</p>
        {crashes === null ? (
          <p className="res-hint">Loading…</p>
        ) : crashes.length === 0 ? (
          <p className="res-hint">No crashes reported. </p>
        ) : (
          crashes.map((c) => (
            <div key={c.id} style={{ borderTop: '1px solid var(--line)', padding: '0.6rem 0' }}>
              <button
                type="button"
                className="button-secondary"
                onClick={() => setOpen(open === c.id ? null : c.id)}
                style={{ width: '100%', textAlign: 'left', border: 'none', background: 'none', padding: 0, cursor: 'pointer' }}
                aria-expanded={open === c.id}
              >
                <div style={{ fontWeight: 700, fontSize: '0.92rem', color: 'var(--ink)', wordBreak: 'break-word' }}>{c.message}</div>
                <div style={{ fontSize: '0.8rem', color: 'var(--ink-soft)', marginTop: 2 }}>
                  {[c.at ? c.at.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '', c.screen && `on ${c.screen}`, c.platform, c.appVersion && `v${c.appVersion}`, c.where]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              </button>
              {open === c.id && c.stack && (
                <pre style={{ margin: '0.5rem 0 0', padding: '0.7rem', background: 'var(--panel-bg)', borderRadius: 10, fontSize: '0.72rem', overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{c.stack}</pre>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
