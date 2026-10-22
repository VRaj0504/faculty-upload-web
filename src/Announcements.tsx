import { useEffect, useState } from 'react';
import {
  collection,
  addDoc,
  deleteDoc,
  doc,
  getDocs,
  query as fsQuery,
  where,
  orderBy,
  onSnapshot,
  serverTimestamp,
  Timestamp,
} from 'firebase/firestore';
import { auth, db } from './firebaseConfig';

type ClassOption = {
  key: string;
  label: string;
  targets: { branch: string; section: string | null }[];
  specializations: string[];
};

type Batch = { key: string; year: number; pg: boolean };

type Announcement = {
  id: string;
  message: string;
  targetBranch: string;
  targetSection: string | null;
  targetAdmissionYear: number | null;
  targetSpecialization: string | null;
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
};

const isPg = (e: RosterEntry) => e.program === 'PG' || /^PG/i.test(e.regNo);
const inBatch = (e: RosterEntry, b: Batch) => e.admissionYear === b.year && isPg(e) === b.pg;

async function getRosterEntries(): Promise<RosterEntry[]> {
  const snap = await getDocs(collection(db, 'roster'));
  return snap.docs.map((d) => ({ ...(d.data() as Omit<RosterEntry, 'regNo'>), regNo: d.id }));
}

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

const BRANCH_WORD = /\b(CSE|ECE|MNC)\b/i;

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
  const academicYearStart = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
  const yearOfStudy = academicYearStart - b.year + 1;
  const prog = b.pg ? 'M.Tech' : 'B.Tech';
  if (yearOfStudy < 1) return `${prog} · Admission ${b.year}`;
  const suffix = yearOfStudy === 1 ? '1st' : yearOfStudy === 2 ? '2nd' : yearOfStudy === 3 ? '3rd' : `${yearOfStudy}th`;
  return `${prog} ${suffix} Year (${b.year})`;
}

function timeAgo(ts: Timestamp | null): string {
  if (!ts) return '';
  const diff = Date.now() - ts.toMillis();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function Announcements() {
  const [rosterEntries, setRosterEntries] = useState<RosterEntry[] | null>(null);
  const [rosterError, setRosterError] = useState('');
  const [selectedBatchKey, setSelectedBatchKey] = useState<string | null>(null);
  const [wholeYear, setWholeYear] = useState(false);
  const [selectedClass, setSelectedClass] = useState<ClassOption | null>(null);
  const [selectedSpecialization, setSelectedSpecialization] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState('');

  const [sent, setSent] = useState<Announcement[]>([]);

  useEffect(() => {
    getRosterEntries()
      .then(setRosterEntries)
      .catch(() => setRosterError('Could not load the roster — try reloading the page.'));
  }, []);

  const batches = rosterEntries ? deriveBatches(rosterEntries) : [];
  const selectedBatch = batches.find((b) => b.key === selectedBatchKey) ?? null;
  const selectedYear = selectedBatch?.year ?? null;

  const classOptions = rosterEntries && selectedBatch ? deriveClassOptions(rosterEntries, selectedBatch) : [];

  useEffect(() => {

    setWholeYear(false);
    setSelectedClass(null);
    setSelectedSpecialization(null);
  }, [selectedBatchKey]);

  useEffect(() => {
    const sevenDaysAgo = Timestamp.fromMillis(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const q = fsQuery(
      collection(db, 'announcements'),
      where('createdAt', '>=', sevenDaysAgo),
      orderBy('createdAt', 'desc'),
    );
    const unsubscribe = onSnapshot(q, (snapshot) => {
      setSent(snapshot.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Announcement, 'id'>) })));
    });
    return () => unsubscribe();
  }, []);

  const handleSend = async () => {
    setError('');
    if (selectedYear === null) {
      setError('Choose the year this is for.');
      return;
    }
    if (!wholeYear && !selectedClass) {
      setError('Choose a class, or check "whole year" to reach everyone in this batch.');
      return;
    }
    if (!wholeYear && selectedClass && selectedClass.specializations.length > 0 && !selectedSpecialization) {
      setError("This class has multiple specializations — choose one, or 'All' for everyone in it.");
      return;
    }
    if (!message.trim()) {
      setError('Type what you want to announce.');
      return;
    }
    setPosting(true);
    try {
      const base = {
        message: message.trim(),
        targetAdmissionYear: selectedYear,
        createdBy: auth.currentUser?.uid,
        createdByName: auth.currentUser?.displayName ?? 'Faculty',
        createdAt: serverTimestamp(),
      };
      if (wholeYear) {

        const targets = classOptions.flatMap((c) => c.targets);
        if (targets.length === 0) {
          setError('No classes found for that batch.');
          setPosting(false);
          return;
        }
        await Promise.all(
          targets.map((t) =>
            addDoc(collection(db, 'announcements'), {
              ...base,
              targetBranch: t.branch,
              targetSection: t.section,
              targetSpecialization: null,
            }),
          ),
        );
      } else if (selectedClass) {
        await Promise.all(
          selectedClass.targets.map((t) =>
            addDoc(collection(db, 'announcements'), {
              ...base,
              targetBranch: t.branch,
              targetSection: t.section,
              targetSpecialization: selectedSpecialization === '__ALL__' ? null : selectedSpecialization,
            }),
          ),
        );
      }
      setMessage('');
      setSelectedBatchKey(null);
      setWholeYear(false);
      setSelectedClass(null);
      setSelectedSpecialization(null);
    } catch (err: any) {
      setError(err.message ?? 'Could not send. Please try again.');
    } finally {
      setPosting(false);
    }
  };

  const handleDelete = async (item: Announcement) => {
    if (!confirm('Delete this announcement? This cannot be undone.')) return;
    try {
      await deleteDoc(doc(db, 'announcements', item.id));
    } catch (err: any) {
      alert(`Could not delete: ${err.message}`);
    }
  };

  const targetLabel = (a: Announcement) =>
    [a.targetBranch, a.targetSection, a.targetSpecialization, a.targetAdmissionYear].filter(Boolean).join(' · ');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '2rem 0' }}>
      <div className="card" style={{ width: 640, padding: '2rem 2.5rem' }}>
        <h1 style={{ fontSize: '1.5rem' }}>Announcements</h1>
        <p style={{ color: 'var(--ink-soft)', fontSize: '0.9rem' }}>
          Goes only to the class you pick, not everyone — for a cancelled class, a room change, etc. Reaches the
          same students instantly (and gets them a push notification) as posting from the mobile app.
        </p>

        {error && <p className="error-text" style={{ marginTop: '1rem' }}>{error}</p>}
        {rosterError && <p className="error-text" style={{ marginTop: '1rem' }}>{rosterError}</p>}

        <div style={{ marginTop: '1.2rem' }}>
          <label>Year (batch)</label>
          {rosterEntries === null ? (
            <p className="eyebrow">Loading…</p>
          ) : batches.length === 0 ? (
            <p style={{ color: 'var(--ink-soft)' }}>No batches found in the roster yet.</p>
          ) : (
            <select value={selectedBatchKey ?? ''} onChange={(e) => setSelectedBatchKey(e.target.value || null)}>
              <option value="" disabled>
                Select a batch
              </option>
              {batches.map((b) => (
                <option key={b.key} value={b.key}>
                  {batchLabel(b)}
                </option>
              ))}
            </select>
          )}
        </div>

        {selectedYear !== null && (
          <div style={{ marginTop: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <input
              type="checkbox"
              id="wholeYear"
              checked={wholeYear}
              onChange={(e) => setWholeYear(e.target.checked)}
              style={{ width: 'auto' }}
            />
            <label htmlFor="wholeYear" style={{ margin: 0, cursor: 'pointer' }}>
              Send to the whole batch — every class in it, not just one
            </label>
          </div>
        )}

        {selectedYear !== null && !wholeYear && (
          <div style={{ marginTop: '0.8rem' }}>
            <label>Class</label>
            {classOptions.length === 0 ? (
              <p style={{ color: 'var(--ink-soft)' }}>No classes found for that batch.</p>
            ) : (
              <select
                value={selectedClass?.key ?? ''}
                onChange={(e) => {
                  const found = classOptions.find((c) => c.key === e.target.value);
                  setSelectedClass(found ?? null);
                  setSelectedSpecialization(null);
                }}
              >
                <option value="" disabled>
                  Select a class
                </option>
                {classOptions.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </select>
            )}
          </div>
        )}

        {!wholeYear && selectedClass && selectedClass.specializations.length > 0 && (
          <div style={{ marginTop: '0.8rem' }}>
            <label>Specialization ({selectedClass.label} has more than one)</label>
            <select
              value={selectedSpecialization ?? ''}
              onChange={(e) => setSelectedSpecialization(e.target.value || null)}
            >
              <option value="" disabled>
                Select one
              </option>
              <option value="__ALL__">All of {selectedClass.label}</option>
              {selectedClass.specializations.map((spec) => (
                <option key={spec} value={spec}>
                  {spec}
                </option>
              ))}
            </select>
          </div>
        )}

        <div style={{ marginTop: '0.8rem' }}>
          <label>Message</label>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="e.g. Today's 2 PM DBMS lecture is cancelled."
            rows={3}
          />
        </div>

        <button onClick={handleSend} disabled={posting} style={{ marginTop: '1.2rem', width: '100%' }}>
          {posting ? 'Sending…' : 'Send Announcement'}
        </button>

        <h2 style={{ fontSize: '1.1rem', marginTop: '2rem' }}>Sent Announcements</h2>
        {sent.length === 0 && <p style={{ color: 'var(--ink-soft)' }}>Nothing sent yet.</p>}
        {sent.map((item) => (
          <div key={item.id} className="list-row" style={{ marginTop: '0.6rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <span className="eyebrow" style={{ fontSize: '0.7rem' }}>{targetLabel(item)}</span>
              <span style={{ fontSize: '0.75rem', color: 'var(--ink-soft)' }}>{timeAgo(item.createdAt)}</span>
            </div>
            <p style={{ margin: '0.4rem 0' }}>{item.message}</p>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '0.75rem', color: 'var(--ink-soft)', fontStyle: 'italic' }}>{item.createdByName}</span>
              {auth.currentUser?.uid === item.createdBy && (
                <button className="button-secondary" onClick={() => handleDelete(item)}>
                  Delete
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default Announcements;
