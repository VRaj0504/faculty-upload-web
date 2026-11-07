import { useEffect, useMemo, useState } from 'react';
import { collection, doc, getDoc, getDocs, query, setDoc, where } from 'firebase/firestore';
import { db } from './firebaseConfig';

type Person = { name: string; email: string };
type Cfg = { dsw?: Person; dean?: Person; fic?: Record<string, Person> };
type Club = { id: string; name: string; parentClubId?: string | null };
type Faculty = { name: string; email: string };

/** Who signs event excusals: each parent club's FIC, then the Dean of Student Welfare, then the Dean of Academics. */
export default function EventExcusalSetup() {
  const [faculty, setFaculty] = useState<Faculty[]>([]);
  const [clubs, setClubs] = useState<Club[]>([]);
  const [cfg, setCfg] = useState<Cfg>({});
  const [status, setStatus] = useState('Loading…');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([
      getDocs(query(collection(db, 'users'), where('role', '==', 'faculty'))),
      getDocs(collection(db, 'clubs')),
      getDoc(doc(db, 'config', 'eventExcusal')),
    ])
      .then(([f, c, x]) => {
        setFaculty(
          f.docs
            .map((d) => d.data() as { name?: string; email?: string })
            .filter((u) => u.email)
            .map((u) => ({ name: u.name ?? u.email!, email: u.email!.toLowerCase() }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        );
        setClubs(c.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Club, 'id'>) })));
        setCfg((x.data() as Cfg) ?? {});
        setStatus('');
      })
      .catch((e) => setStatus(`Couldn't load: ${e.message}`));
  }, []);

  const parents = useMemo(() => clubs.filter((c) => !c.parentClubId).sort((a, b) => a.name.localeCompare(b.name)), [clubs]);
  const subsOf = (id: string) => clubs.filter((c) => c.parentClubId === id).map((c) => c.name).sort();

  const pick = (email: string): Person | undefined => {
    const f = faculty.find((x) => x.email === email);
    return f ? { name: f.name, email: f.email } : undefined;
  };

  const FacultySelect = ({ value, onChange }: { value?: Person; onChange: (p?: Person) => void }) => (
    <select value={value?.email ?? ''} onChange={(e) => onChange(pick(e.target.value))} style={{ minWidth: 260 }}>
      <option value="">Not set</option>
      {value?.email && !faculty.some((f) => f.email === value.email) && <option value={value.email}>{value.name} (not signed in yet)</option>}
      {faculty.map((f) => (
        <option key={f.email} value={f.email}>
          {f.name} · {f.email}
        </option>
      ))}
    </select>
  );

  const save = async () => {
    setSaving(true);
    try {
      const clean: Cfg = {
        ...(cfg.dsw ? { dsw: cfg.dsw } : {}),
        ...(cfg.dean ? { dean: cfg.dean } : {}),
        fic: Object.fromEntries(Object.entries(cfg.fic ?? {}).filter(([, p]) => p?.email)),
      };
      await setDoc(doc(db, 'config', 'eventExcusal'), clean);
      setStatus('Saved. New requests use these signers.');
    } catch (e: any) {
      setStatus(`Couldn't save: ${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  const missing = parents.filter((p) => !cfg.fic?.[p.id]?.email).length;

  return (
    <div className="card" style={{ maxWidth: 820, padding: '1.5rem' }}>
      <h1 style={{ fontSize: '1.3rem', marginTop: 0 }}>Event excusal signers</h1>
      <p style={{ color: 'var(--ink-soft)' }}>
        A club lead sends the student list. It is signed in this order: the parent club's faculty in-charge → Dean, Student Welfare → Dean,
        Academics. When the last one signs, those students' classes count as attended (shown as <b>EV</b> in the register).
      </p>
      {status && <p className="res-hint">{status}</p>}

      <h2 style={{ fontSize: '1.05rem' }}>Deans</h2>
      <table>
        <tbody>
          <tr>
            <td>Dean, Student Welfare</td>
            <td>
              <FacultySelect value={cfg.dsw} onChange={(p) => setCfg((c) => ({ ...c, dsw: p }))} />
            </td>
          </tr>
          <tr>
            <td>Dean, Academics</td>
            <td>
              <FacultySelect value={cfg.dean} onChange={(p) => setCfg((c) => ({ ...c, dean: p }))} />
            </td>
          </tr>
        </tbody>
      </table>

      <h2 style={{ fontSize: '1.05rem', marginTop: '1.5rem' }}>Faculty in-charge (FIC) of each club{missing ? ` · ${missing} not set` : ''}</h2>
      <p className="res-hint">Sub-clubs use their parent club's FIC, e.g. Football → Indominous, Exposure → Imagine.</p>
      <table>
        <thead>
          <tr>
            <th>Club</th>
            <th>FIC</th>
          </tr>
        </thead>
        <tbody>
          {parents.map((p) => {
            const subs = subsOf(p.id);
            return (
              <tr key={p.id}>
                <td>
                  <b>{p.name}</b>
                  {subs.length > 0 && <div style={{ fontSize: '0.78rem', color: 'var(--ink-soft)' }}>{subs.join(', ')}</div>}
                </td>
                <td>
                  <FacultySelect
                    value={cfg.fic?.[p.id]}
                    onChange={(v) => setCfg((c) => ({ ...c, fic: { ...(c.fic ?? {}), [p.id]: v as Person } }))}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div style={{ marginTop: '1.25rem' }}>
        <button type="button" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}
