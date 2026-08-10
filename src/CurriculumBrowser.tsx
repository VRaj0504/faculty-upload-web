import { useState, useEffect, useMemo } from 'react';
import { collection, getDocs, doc, setDoc, deleteDoc } from 'firebase/firestore';
import { db } from './firebaseConfig';

type CurriculumRow = {
  id: string; // "{branch}_{semester}_{code}"
  branch: string;
  semester: number;
  code: string;
  name: string;
};

function docIdFor(branch: string, semester: number, code: string) {
  return `${branch}_${semester}_${code}`;
}

function CurriculumBrowser() {
  const [rows, setRows] = useState<CurriculumRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [search, setSearch] = useState('');
  const [branchFilter, setBranchFilter] = useState('All');
  const [semesterFilter, setSemesterFilter] = useState('All');

  // Only `name` is editable inline — branch/semester/code together form
  // this doc's Firestore ID (see docIdFor above), so changing any of them
  // would mean creating a new doc and deleting the old one, not a normal
  // field update. If one of those needs correcting, delete the row and
  // re-add it with the right key instead.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const [showAddForm, setShowAddForm] = useState(false);
  const [addDraft, setAddDraft] = useState({ branch: '', semester: 1, code: '', name: '' });
  const [adding, setAdding] = useState(false);

  const loadCurriculum = async () => {
    setLoading(true);
    setLoadError('');
    try {
      const snap = await getDocs(collection(db, 'curriculum'));
      const data = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<CurriculumRow, 'id'>) }));
      data.sort((a, b) => a.branch.localeCompare(b.branch) || a.semester - b.semester || a.code.localeCompare(b.code));
      setRows(data);
    } catch (err: any) {
      setLoadError(`Could not load the curriculum: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadCurriculum();
  }, []);

  const branches = useMemo(() => {
    const set = new Set(rows.map((r) => r.branch).filter(Boolean));
    return ['All', ...Array.from(set).sort()];
  }, [rows]);

  const semesters = useMemo(() => {
    const set = new Set(rows.map((r) => r.semester));
    return ['All', ...Array.from(set).sort((a, b) => a - b).map(String)];
  }, [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (branchFilter !== 'All' && r.branch !== branchFilter) return false;
      if (semesterFilter !== 'All' && String(r.semester) !== semesterFilter) return false;
      if (!q) return true;
      return r.code.toLowerCase().includes(q) || r.name.toLowerCase().includes(q);
    });
  }, [rows, search, branchFilter, semesterFilter]);

  const startEdit = (row: CurriculumRow) => {
    setEditingId(row.id);
    setEditName(row.name);
  };

  const saveEdit = async (row: CurriculumRow) => {
    if (!editName.trim()) {
      alert('Name is required.');
      return;
    }
    setBusyId(row.id);
    try {
      await setDoc(doc(db, 'curriculum', row.id), {
        branch: row.branch,
        semester: row.semester,
        code: row.code,
        name: editName.trim(),
      });
      setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, name: editName.trim() } : r)));
      setEditingId(null);
    } catch (err: any) {
      alert(`Could not save: ${err.message}`);
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (row: CurriculumRow) => {
    if (!confirm(`Remove "${row.name}" (${row.code}) from ${row.branch} Sem ${row.semester}? This can't be undone.`))
      return;
    setBusyId(row.id);
    try {
      await deleteDoc(doc(db, 'curriculum', row.id));
      setRows((prev) => prev.filter((r) => r.id !== row.id));
    } catch (err: any) {
      alert(`Could not delete: ${err.message}`);
    } finally {
      setBusyId(null);
    }
  };

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const branch = addDraft.branch.trim().toUpperCase();
    const code = addDraft.code.trim().toUpperCase();
    const name = addDraft.name.trim();
    if (!branch || !code || !name || !addDraft.semester) {
      alert('Branch, semester, code, and name are all required.');
      return;
    }
    const id = docIdFor(branch, addDraft.semester, code);
    if (rows.some((r) => r.id === id)) {
      if (!confirm(`${branch} Sem ${addDraft.semester} ${code} already exists — overwrite it?`)) return;
    }
    setAdding(true);
    try {
      await setDoc(doc(db, 'curriculum', id), { branch, semester: addDraft.semester, code, name });
      setRows((prev) =>
        [...prev.filter((r) => r.id !== id), { id, branch, semester: addDraft.semester, code, name }].sort(
          (a, b) => a.branch.localeCompare(b.branch) || a.semester - b.semester || a.code.localeCompare(b.code),
        ),
      );
      setAddDraft({ branch: '', semester: 1, code: '', name: '' });
      setShowAddForm(false);
    } catch (err: any) {
      alert(`Could not add: ${err.message}`);
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="card" style={{ width: 720, maxWidth: '92vw', padding: '2.5rem', margin: '3rem auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 style={{ fontSize: '1.5rem' }}>Browse Curriculum</h1>
        </div>
        <button className="button-secondary" onClick={loadCurriculum} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {loadError && <p className="error-text" style={{ marginTop: '1rem' }}>{loadError}</p>}

      {!loading && !loadError && (
        <>
          <div style={{ display: 'flex', gap: '0.6rem', marginTop: '1.4rem', flexWrap: 'wrap' }}>
            <input
              style={{ flex: 1, minWidth: 160 }}
              placeholder="Search by code or subject name…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select style={{ width: 120 }} value={branchFilter} onChange={(e) => setBranchFilter(e.target.value)}>
              {branches.map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
            <select style={{ width: 110 }} value={semesterFilter} onChange={(e) => setSemesterFilter(e.target.value)}>
              {semesters.map((s) => (
                <option key={s} value={s}>{s === 'All' ? 'All sems' : `Sem ${s}`}</option>
              ))}
            </select>
          </div>

          <p style={{ fontSize: '0.8rem', color: 'var(--ink-soft)', marginTop: '0.6rem' }}>
            {filtered.length} of {rows.length} subjects
          </p>

          <button
            className="button-secondary"
            style={{ marginTop: '0.8rem' }}
            onClick={() => setShowAddForm((v) => !v)}
          >
            {showAddForm ? 'Cancel' : '+ Add one subject manually'}
          </button>

          {showAddForm && (
            <form
              onSubmit={handleAdd}
              style={{ marginTop: '0.8rem', padding: '1rem', border: '1px solid var(--line)', borderRadius: 4 }}
            >
              <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
                <input
                  style={{ flex: '1 1 100px' }}
                  placeholder="Branch"
                  value={addDraft.branch}
                  onChange={(e) => setAddDraft((d) => ({ ...d, branch: e.target.value }))}
                />
                <select
                  style={{ flex: '1 1 100px' }}
                  value={addDraft.semester}
                  onChange={(e) => setAddDraft((d) => ({ ...d, semester: Number(e.target.value) }))}
                >
                  {[1, 2, 3, 4, 5, 6, 7, 8].map((s) => (
                    <option key={s} value={s}>Sem {s}</option>
                  ))}
                </select>
                <input
                  style={{ flex: '1 1 110px' }}
                  placeholder="Code"
                  value={addDraft.code}
                  onChange={(e) => setAddDraft((d) => ({ ...d, code: e.target.value }))}
                />
              </div>
              <input
                style={{ marginTop: '0.6rem' }}
                placeholder="Subject name"
                value={addDraft.name}
                onChange={(e) => setAddDraft((d) => ({ ...d, name: e.target.value }))}
              />
              <button type="submit" disabled={adding} style={{ marginTop: '0.8rem' }}>
                {adding ? 'Adding…' : 'Add subject'}
              </button>
            </form>
          )}

          <div style={{ marginTop: '1.2rem' }}>
            {filtered.length === 0 && (
              <p style={{ color: 'var(--ink-soft)' }}>No subjects match this search.</p>
            )}
            {filtered.map((row) => {
              const editing = editingId === row.id;
              const busy = busyId === row.id;
              return (
                <div key={row.id} className="list-row" style={{ padding: '0.8rem 0', borderBottom: '1px solid var(--line)' }}>
                  {editing ? (
                    <div>
                      <div className="eyebrow" style={{ fontSize: '0.65rem' }}>
                        {row.branch} · Sem {row.semester} · {row.code}
                        <span style={{ marginLeft: 8 }}>(delete + re-add to change branch/sem/code)</span>
                      </div>
                      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.4rem' }}>
                        <input style={{ flex: 1 }} value={editName} onChange={(e) => setEditName(e.target.value)} />
                        <button disabled={busy} onClick={() => saveEdit(row)}>
                          {busy ? 'Saving…' : 'Save'}
                        </button>
                        <button className="button-secondary" onClick={() => setEditingId(null)}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div>
                        <div style={{ fontWeight: 500 }}>{row.name}</div>
                        <div className="eyebrow" style={{ fontSize: '0.65rem' }}>
                          {row.branch} · Sem {row.semester} · {row.code}
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: '0.4rem', flexShrink: 0 }}>
                        <button className="button-secondary" disabled={busy} onClick={() => startEdit(row)}>
                          Edit
                        </button>
                        <button className="button-secondary" disabled={busy} onClick={() => handleDelete(row)}>
                          Delete
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

export default CurriculumBrowser;
