import { useEffect, useState } from 'react';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query as fsQuery,
  serverTimestamp,
  Timestamp,
} from 'firebase/firestore';
import { auth, db } from './firebaseConfig';

// The app's Notices tab (Academic / Placement / Event / General), posted
// from the portal. Same `notices` collection and field names as the mobile
// app's noticesService.ts, so the existing sendNoticePush function sends the
// push notification either way. Class targeting is picked from the live
// roster (dropdowns, never typed).
type Category = 'Academic' | 'Placement' | 'Event' | 'General';
const CATEGORIES: Category[] = ['Academic', 'Placement', 'Event', 'General'];

type Notice = {
  id: string;
  title: string;
  description: string;
  category: string;
  clubName: string | null;
  link?: string | null;
  targetBranch?: string | null;
  targetSection?: string | null;
  targetAdmissionYear?: number | null;
  targetSpecialization?: string | null;
  createdBy: string;
  createdByName: string;
  createdAt: Timestamp | null;
};

type RosterEntry = {
  regNo: string;
  branch?: string;
  section?: string;
  specialization?: string;
  admissionYear?: number;
  program?: 'UG' | 'PG';
  reviewer?: boolean;
};
type ClassOption = {
  key: string;
  label: string;
  targets: { branch: string; section: string | null }[];
  specializations: string[];
};
type Batch = { key: string; year: number; pg: boolean };

const isPg = (e: RosterEntry) => e.program === 'PG' || /^PG/i.test(e.regNo);
const inBatch = (e: RosterEntry, b: Batch) => e.admissionYear === b.year && isPg(e) === b.pg;
const BRANCH_WORD = /\b(CSE|ECE|MNC)\b/i;

function deriveBatches(entries: RosterEntry[]): Batch[] {
  const seen = new Map<string, Batch>();
  entries.forEach((e) => {
    if (typeof e.admissionYear !== 'number') return;
    const pg = isPg(e);
    const key = `${e.admissionYear}|${pg ? 'PG' : 'UG'}`;
    if (!seen.has(key)) seen.set(key, { key, year: e.admissionYear, pg });
  });
  return Array.from(seen.values()).sort((a, b) => b.year - a.year || Number(a.pg) - Number(b.pg));
}

function deriveClassOptions(entries: RosterEntry[], batch: Batch): ClassOption[] {
  const seen = new Map<string, ClassOption>();
  entries.forEach((data) => {
    if (!inBatch(data, batch) || !data.branch) return;
    const section = data.section?.trim() || null;
    const key = section ?? `branch:${data.branch}`;
    let opt = seen.get(key);
    if (!opt) {
      const label = !section ? data.branch : BRANCH_WORD.test(section) ? section : `${data.branch} ${section}`;
      opt = { key, label, targets: [], specializations: [] };
      seen.set(key, opt);
    }
    if (!opt.targets.some((t) => t.branch === data.branch && t.section === section)) {
      opt.targets.push({ branch: data.branch, section });
    }
    if (data.specialization && !opt.specializations.includes(data.specialization)) {
      opt.specializations.push(data.specialization);
    }
  });
  const options = Array.from(seen.values());
  options.forEach((o) => o.specializations.sort());
  return options.sort((a, b) => a.label.localeCompare(b.label));
}

function batchLabel(b: Batch): string {
  const now = new Date();
  const start = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
  const yos = start - b.year + 1;
  const prog = b.pg ? 'M.Tech' : 'B.Tech';
  if (yos < 1) return `${prog} · Admission ${b.year}`;
  const suffix = yos === 1 ? '1st' : yos === 2 ? '2nd' : yos === 3 ? '3rd' : `${yos}th`;
  return `${prog} ${suffix} Year (${b.year})`;
}

function timeAgo(ts: Timestamp | null): string {
  if (!ts) return '';
  const mins = Math.floor((Date.now() - ts.toMillis()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// Only http(s) links, like the app's safeLink.
function cleanLink(raw: string): string | null | 'bad' {
  const t = raw.trim();
  if (!t) return null;
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(t) ? t : `https://${t}`);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : 'bad';
  } catch {
    return 'bad';
  }
}

export default function Notices() {
  const [roster, setRoster] = useState<RosterEntry[] | null>(null);
  const [rosterError, setRosterError] = useState('');
  const [audience, setAudience] = useState<'everyone' | 'batch' | 'class'>('everyone');
  const [batchKey, setBatchKey] = useState('');
  const [classKey, setClassKey] = useState('');
  const [spec, setSpec] = useState('');
  const [category, setCategory] = useState<Category>('General');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [link, setLink] = useState('');
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [notices, setNotices] = useState<Notice[]>([]);

  useEffect(() => {
    getDocs(collection(db, 'roster'))
      .then((s) =>
        setRoster(
          s.docs
            .map((d) => ({ ...(d.data() as Omit<RosterEntry, 'regNo'>), regNo: d.id }))
            .filter((e) => !e.reviewer),
        ),
      )
      .catch(() => setRosterError('Could not load the roster — reload the page to target a class.'));
  }, []);

  useEffect(() => {
    const q = fsQuery(collection(db, 'notices'), orderBy('createdAt', 'desc'), limit(100));
    return onSnapshot(q, (s) => setNotices(s.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Notice, 'id'>) }))));
  }, []);

  const batches = roster ? deriveBatches(roster) : [];
  const batch = batches.find((b) => b.key === batchKey) ?? null;
  const classOptions = roster && batch ? deriveClassOptions(roster, batch) : [];
  const cls = classOptions.find((c) => c.key === classKey) ?? null;

  const post = async () => {
    setError('');
    setDone('');
    if (!title.trim() || !description.trim()) return setError('Fill in a title and a description.');
    const l = cleanLink(link);
    if (l === 'bad') return setError('The link must start with http:// or https://');
    if (audience !== 'everyone' && !batch) return setError('Choose the batch.');
    if (audience === 'class' && !cls) return setError('Choose the class.');
    if (audience === 'class' && cls && cls.specializations.length > 0 && !spec)
      return setError(`${cls.label} has more than one specialization — choose one, or "All".`);

    // One notice per branch+section the audience covers (a class like CSE D
    // holds more than one branch). "Everyone" is a single notice.
    let targets: { branch: string | null; section: string | null; year: number | null }[];
    if (audience === 'everyone') targets = [{ branch: null, section: null, year: null }];
    else if (audience === 'batch') {
      const t = classOptions.flatMap((c) => c.targets);
      if (!t.length) return setError('No classes found for that batch.');
      targets = t.map((x) => ({ branch: x.branch, section: x.section, year: batch!.year }));
    } else targets = cls!.targets.map((x) => ({ branch: x.branch, section: x.section, year: batch!.year }));

    setPosting(true);
    try {
      await Promise.all(
        targets.map((t) =>
          addDoc(collection(db, 'notices'), {
            title: title.trim(),
            description: description.trim(),
            category,
            clubId: null,
            clubName: null,
            ...(l ? { link: l } : {}),
            targetBranch: t.branch,
            targetSection: t.section,
            targetAdmissionYear: t.year,
            targetSpecialization: audience === 'class' && spec && spec !== '__ALL__' ? spec : null,
            createdBy: auth.currentUser?.uid,
            createdByName: auth.currentUser?.displayName ?? 'Faculty',
            createdAt: serverTimestamp(),
          }),
        ),
      );
      setDone('Notice posted — students see it in the app now.');
      setTitle('');
      setDescription('');
      setLink('');
      setAudience('everyone');
      setBatchKey('');
      setClassKey('');
      setSpec('');
    } catch (e: any) {
      setError(e?.message ?? 'Could not post the notice. Try again.');
    } finally {
      setPosting(false);
    }
  };

  const remove = async (n: Notice) => {
    if (!confirm('Delete this notice for everyone? This cannot be undone.')) return;
    try {
      await deleteDoc(doc(db, 'notices', n.id));
    } catch (e: any) {
      alert(`Could not delete: ${e?.message ?? 'unknown error'}`);
    }
  };

  const audienceLabel = (n: Notice) => {
    const parts = [n.targetBranch, n.targetSection, n.targetSpecialization, n.targetAdmissionYear].filter(Boolean);
    return parts.length ? parts.join(' · ') : 'Everyone';
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '2rem 0' }}>
      <div className="card" style={{ width: 640, maxWidth: '100%', padding: '2rem 2.5rem' }}>
        <h1 style={{ fontSize: '1.5rem' }}>Notices</h1>
        <p style={{ color: 'var(--ink-soft)', fontSize: '0.9rem' }}>
          Goes on the app's Notices board (and sends a push notification) — for circulars, placement news, events
          and so on. Use Announcements instead for a quick message to one class.
        </p>

        {error && <p className="error-text" style={{ marginTop: '1rem' }}>{error}</p>}
        {rosterError && <p className="error-text" style={{ marginTop: '1rem' }}>{rosterError}</p>}
        {done && <p style={{ marginTop: '1rem', color: 'var(--ok, #15803d)' }}>{done}</p>}

        <div style={{ marginTop: '1.2rem' }}>
          <label>Category</label>
          <select value={category} onChange={(e) => setCategory(e.target.value as Category)}>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>

        <div style={{ marginTop: '0.8rem' }}>
          <label>Who should see it</label>
          <select
            value={audience}
            onChange={(e) => {
              setAudience(e.target.value as 'everyone' | 'batch' | 'class');
              setClassKey('');
              setSpec('');
            }}
          >
            <option value="everyone">Everyone</option>
            <option value="batch">A whole batch</option>
            <option value="class">One class</option>
          </select>
        </div>

        {audience !== 'everyone' && (
          <div style={{ marginTop: '0.8rem' }}>
            <label>Batch</label>
            {roster === null ? (
              <p className="eyebrow">Loading…</p>
            ) : (
              <select
                value={batchKey}
                onChange={(e) => {
                  setBatchKey(e.target.value);
                  setClassKey('');
                  setSpec('');
                }}
              >
                <option value="" disabled>Select a batch</option>
                {batches.map((b) => (
                  <option key={b.key} value={b.key}>{batchLabel(b)}</option>
                ))}
              </select>
            )}
          </div>
        )}

        {audience === 'class' && batch && (
          <div style={{ marginTop: '0.8rem' }}>
            <label>Class</label>
            <select
              value={classKey}
              onChange={(e) => {
                setClassKey(e.target.value);
                setSpec('');
              }}
            >
              <option value="" disabled>Select a class</option>
              {classOptions.map((c) => (
                <option key={c.key} value={c.key}>{c.label}</option>
              ))}
            </select>
          </div>
        )}

        {audience === 'class' && cls && cls.specializations.length > 0 && (
          <div style={{ marginTop: '0.8rem' }}>
            <label>Specialization ({cls.label} has more than one)</label>
            <select value={spec} onChange={(e) => setSpec(e.target.value)}>
              <option value="" disabled>Select one</option>
              <option value="__ALL__">All of {cls.label}</option>
              {cls.specializations.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
        )}

        <div style={{ marginTop: '0.8rem' }}>
          <label>Title</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Mid-sem exam seating plan" maxLength={120} />
        </div>

        <div style={{ marginTop: '0.8rem' }}>
          <label>Description</label>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={5} placeholder="Write the full notice here." />
        </div>

        <div style={{ marginTop: '0.8rem' }}>
          <label>Link (optional)</label>
          <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://…" />
        </div>

        <button onClick={post} disabled={posting} style={{ marginTop: '1.2rem', width: '100%' }}>
          {posting ? 'Posting…' : 'Post Notice'}
        </button>

        <h2 style={{ fontSize: '1.1rem', marginTop: '2rem' }}>Recent notices</h2>
        {notices.length === 0 && <p style={{ color: 'var(--ink-soft)' }}>No notices yet.</p>}
        {notices.map((n) => (
          <div key={n.id} className="list-row" style={{ marginTop: '0.6rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
              <span className="eyebrow" style={{ fontSize: '0.7rem' }}>
                {n.clubName ? `${n.category} · ${n.clubName}` : n.category} · {audienceLabel(n)}
              </span>
              <span style={{ fontSize: '0.75rem', color: 'var(--ink-soft)', whiteSpace: 'nowrap' }}>{timeAgo(n.createdAt)}</span>
            </div>
            <p style={{ margin: '0.4rem 0 0', fontWeight: 600 }}>{n.title}</p>
            <p style={{ margin: '0.2rem 0 0.4rem', whiteSpace: 'pre-wrap' }}>{n.description}</p>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '0.75rem', color: 'var(--ink-soft)', fontStyle: 'italic' }}>{n.createdByName}</span>
              <button className="button-secondary" onClick={() => remove(n)}>Delete</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
