import { useEffect, useState } from 'react';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db } from './firebaseConfig';

type Highlights = { date: string; companiesVisited: string; offers: string; highest: string; placementPercent: string };
type Branch = { branch: string; maxPackage: string; avgPackage: string; median: string; placementPercent: string };

const DEFAULTS: { highlights: Highlights; branches: Branch[]; link: string } = {
  highlights: { date: 'May 30, 2026', companiesVisited: '75+', offers: '100+', highest: '54.89 LPA', placementPercent: '63.38%' },
  branches: [
    { branch: 'CSE', maxPackage: '51 LPA', avgPackage: '16.69 LPA', median: '20 LPA', placementPercent: '65.75%' },
    { branch: 'ECE', maxPackage: '54.89 LPA', avgPackage: '12.32 LPA', median: '10 LPA', placementPercent: '60.87%' },
    { branch: 'Total', maxPackage: '54.89 LPA', avgPackage: '14.65 LPA', median: '12.25 LPA', placementPercent: '63.38%' },
  ],
  link: '',
};

const BRANCH_OPTIONS = ['CSE', 'ECE', 'MNC', 'Total'];

const HIGHLIGHT_FIELDS: { key: keyof Highlights; label: string; hint: string }[] = [
  { key: 'date', label: 'Updated as of', hint: 'e.g. May 30, 2026' },
  { key: 'companiesVisited', label: 'Companies visited', hint: 'e.g. 75+' },
  { key: 'offers', label: 'Offers made', hint: 'e.g. 100+' },
  { key: 'highest', label: 'Highest package', hint: 'e.g. 54.89 LPA' },
  { key: 'placementPercent', label: 'Placement %', hint: 'e.g. 63.38%' },
];

const BRANCH_FIELDS: { key: Exclude<keyof Branch, 'branch'>; label: string }[] = [
  { key: 'maxPackage', label: 'Highest' },
  { key: 'avgPackage', label: 'Average' },
  { key: 'median', label: 'Median' },
  { key: 'placementPercent', label: 'Placed %' },
];

export default function PlacementStats() {
  const [highlights, setHighlights] = useState<Highlights>(DEFAULTS.highlights);
  const [branches, setBranches] = useState<Branch[]>(DEFAULTS.branches);
  const [link, setLink] = useState(DEFAULTS.link);
  const [status, setStatus] = useState('Loading…');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getDoc(doc(db, 'config', 'placementStats'))
      .then((snap) => {
        if (snap.exists()) {
          const d = snap.data() as Partial<typeof DEFAULTS>;
          if (d.highlights) setHighlights({ ...DEFAULTS.highlights, ...d.highlights });
          if (Array.isArray(d.branches) && d.branches.length) setBranches(d.branches);
          if (typeof d.link === 'string') setLink(d.link);
          setStatus('');
        } else {
          setStatus('Showing the numbers built into the app. Save once to start editing them here.');
        }
      })
      .catch((e) => setStatus(`Couldn't load: ${e.message}`));
  }, []);

  const setBranch = (i: number, patch: Partial<Branch>) => setBranches((list) => list.map((b, idx) => (idx === i ? { ...b, ...patch } : b)));
  const unusedBranches = BRANCH_OPTIONS.filter((b) => !branches.some((x) => x.branch === b));

  const save = async () => {
    if (HIGHLIGHT_FIELDS.some((f) => !highlights[f.key].trim())) {
      setStatus('Fill in every highlight field.');
      return;
    }
    if (link.trim() && !/^https:\/\//i.test(link.trim())) {
      setStatus('The link must start with https://');
      return;
    }
    setSaving(true);
    try {
      const ordered = [...branches].sort((a, b) => BRANCH_OPTIONS.indexOf(a.branch) - BRANCH_OPTIONS.indexOf(b.branch));
      await setDoc(doc(db, 'config', 'placementStats'), {
        highlights: Object.fromEntries(Object.entries(highlights).map(([k, v]) => [k, v.trim()])),
        branches: ordered.map((b) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v.trim()]))),
        link: link.trim() || null,
      });
      setBranches(ordered);
      setStatus('Saved. Students see the new numbers right away.');
    } catch (e: any) {
      setStatus(`Couldn't save: ${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card" style={{ maxWidth: 820, padding: '2rem', margin: '2rem auto' }}>
      <h1 style={{ fontSize: '1.5rem' }}>Placement numbers</h1>
      <p style={{ fontSize: '0.85rem', color: 'var(--ink-soft)' }}>
        These show on the Placements page in the app. Type them exactly as students should see them.
      </p>

      <h2 style={{ fontSize: '1.05rem', marginTop: '1.5rem' }}>Highlights</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '0.75rem' }}>
        {HIGHLIGHT_FIELDS.map((f) => (
          <div key={f.key}>
            <label>{f.label}</label>
            <input value={highlights[f.key]} placeholder={f.hint} onChange={(e) => setHighlights((h) => ({ ...h, [f.key]: e.target.value }))} />
          </div>
        ))}
      </div>

      <h2 style={{ fontSize: '1.05rem', marginTop: '1.5rem' }}>Branch-wise</h2>
      <div style={{ display: 'grid', gap: '0.6rem' }}>
        {branches.map((b, i) => (
          <div key={`${b.branch}-${i}`} style={{ display: 'grid', gridTemplateColumns: '110px repeat(4, 1fr) 36px', gap: '0.5rem', alignItems: 'end' }}>
            <div>
              <label>Branch</label>
              <select value={b.branch} onChange={(e) => setBranch(i, { branch: e.target.value })}>
                {[b.branch, ...unusedBranches].map((o) => (
                  <option key={o} value={o}>
                    {o === 'Total' ? 'All branches' : o}
                  </option>
                ))}
              </select>
            </div>
            {BRANCH_FIELDS.map((f) => (
              <div key={f.key}>
                <label>{f.label}</label>
                <input value={b[f.key]} onChange={(e) => setBranch(i, { [f.key]: e.target.value } as Partial<Branch>)} />
              </div>
            ))}
            <button
              type="button"
              className="button-secondary"
              title="Remove row"
              onClick={() => setBranches((list) => list.filter((_, idx) => idx !== i))}
              style={{ padding: '0.5rem' }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
      {unusedBranches.length > 0 && (
        <button
          type="button"
          className="button-secondary"
          style={{ marginTop: '0.6rem' }}
          onClick={() => setBranches((list) => [...list, { branch: unusedBranches[0], maxPackage: '', avgPackage: '', median: '', placementPercent: '' }])}
        >
          + Add branch
        </button>
      )}

      <h2 style={{ fontSize: '1.05rem', marginTop: '1.5rem' }}>"View full placement data" link</h2>
      <input value={link} placeholder="https://… (leave empty to hide the link)" onChange={(e) => setLink(e.target.value)} />

      {status && <p style={{ marginTop: '1rem', fontSize: '0.9rem' }}>{status}</p>}
      <button onClick={save} disabled={saving} style={{ width: '100%', marginTop: '1rem' }}>
        {saving ? 'Saving…' : 'Save placement numbers'}
      </button>
    </div>
  );
}
