import { useState, useEffect, useMemo } from 'react';
import { collection, getDocs, doc, setDoc, deleteDoc } from 'firebase/firestore';
import { db } from './firebaseConfig';

type RosterRow = {
  regNo: string;
  name: string;
  branch: string;
  section: string;
  admissionYear: number;
};

const PAGE_SIZE = 200;

function RosterBrowser() {
  const [rows, setRows] = useState<RosterRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [search, setSearch] = useState('');
  const [branchFilter, setBranchFilter] = useState<string>('All');

  const [editingRegNo, setEditingRegNo] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Omit<RosterRow, 'regNo'>>({
    name: '',
    branch: '',
    section: '',
    admissionYear: new Date().getFullYear(),
  });
  const [busyRegNo, setBusyRegNo] = useState<string | null>(null);

  // Manual single-entry add — a much lighter path than building a whole
  // spreadsheet for the "one new student joined mid-semester" case.
  const [showAddForm, setShowAddForm] = useState(false);
  const [addDraft, setAddDraft] = useState<RosterRow>({
    regNo: '',
    name: '',
    branch: '',
    section: '',
    admissionYear: new Date().getFullYear(),
  });
  const [adding, setAdding] = useState(false);

  const loadRoster = async () => {
    setLoading(true);
    setLoadError('');
    try {
      const snap = await getDocs(collection(db, 'roster'));
      const data = snap.docs.map((d) => ({ regNo: d.id, ...(d.data() as Omit<RosterRow, 'regNo'>) }));
      data.sort((a, b) => a.regNo.localeCompare(b.regNo));
      setRows(data);
    } catch (err: any) {
      setLoadError(`Could not load the roster: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadRoster();
  }, []);

  const branches = useMemo(() => {
    const set = new Set(rows.map((r) => r.branch).filter(Boolean));
    return ['All', ...Array.from(set).sort()];
  }, [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (branchFilter !== 'All' && r.branch !== branchFilter) return false;
      if (!q) return true;
      return r.regNo.toLowerCase().includes(q) || r.name.toLowerCase().includes(q);
    });
  }, [rows, search, branchFilter]);

  const displayed = filtered.slice(0, PAGE_SIZE);

  const startEdit = (row: RosterRow) => {
    setEditingRegNo(row.regNo);
    setEditDraft({ name: row.name, branch: row.branch, section: row.section, admissionYear: row.admissionYear });
  };

  const saveEdit = async (regNo: string) => {
    if (!editDraft.name.trim() || !editDraft.branch.trim()) {
      alert('Name and branch are required.');
      return;
    }
    setBusyRegNo(regNo);
    try {
      await setDoc(doc(db, 'roster', regNo), {
        name: editDraft.name.trim(),
        branch: editDraft.branch.trim().toUpperCase(),
        section: editDraft.section.trim(),
        admissionYear: Number(editDraft.admissionYear),
      });
      setRows((prev) =>
        prev.map((r) =>
          r.regNo === regNo
            ? { ...r, ...editDraft, branch: editDraft.branch.trim().toUpperCase(), name: editDraft.name.trim() }
            : r,
        ),
      );
      setEditingRegNo(null);
    } catch (err: any) {
      alert(`Could not save: ${err.message}`);
    } finally {
      setBusyRegNo(null);
    }
  };

  const handleDelete = async (row: RosterRow) => {
    if (!confirm(`Remove ${row.name} (${row.regNo}) from the roster? This can't be undone.`)) return;
    setBusyRegNo(row.regNo);
    try {
      await deleteDoc(doc(db, 'roster', row.regNo));
      setRows((prev) => prev.filter((r) => r.regNo !== row.regNo));
    } catch (err: any) {
      alert(`Could not delete: ${err.message}`);
    } finally {
      setBusyRegNo(null);
    }
  };

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const regNo = addDraft.regNo.trim().toUpperCase();
    if (!regNo || !addDraft.name.trim() || !addDraft.branch.trim()) {
      alert('Reg. no., name, and branch are required.');
      return;
    }
    if (rows.some((r) => r.regNo === regNo)) {
      if (!confirm(`${regNo} already exists in the roster — overwrite it?`)) return;
    }
    setAdding(true);
    try {
      const entry: RosterRow = {
        regNo,
        name: addDraft.name.trim(),
        branch: addDraft.branch.trim().toUpperCase(),
        section: addDraft.section.trim(),
        admissionYear: Number(addDraft.admissionYear),
      };
      await setDoc(doc(db, 'roster', regNo), {
        name: entry.name,
        branch: entry.branch,
        section: entry.section,
        admissionYear: entry.admissionYear,
      });
      setRows((prev) => [...prev.filter((r) => r.regNo !== regNo), entry].sort((a, b) => a.regNo.localeCompare(b.regNo)));
      setAddDraft({ regNo: '', name: '', branch: '', section: '', admissionYear: new Date().getFullYear() });
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
          <h1 style={{ fontSize: '1.5rem' }}>Browse Roster</h1>
        </div>
        <button className="button-secondary" onClick={loadRoster} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {loadError && <p className="error-text" style={{ marginTop: '1rem' }}>{loadError}</p>}

      {!loading && !loadError && (
        <>
          <div style={{ display: 'flex', gap: '0.6rem', marginTop: '1.4rem', flexWrap: 'wrap' }}>
            <input
              style={{ flex: 1, minWidth: 180 }}
              placeholder="Search by reg. no. or name…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select style={{ width: 140 }} value={branchFilter} onChange={(e) => setBranchFilter(e.target.value)}>
              {branches.map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
          </div>

          <p style={{ fontSize: '0.8rem', color: 'var(--ink-soft)', marginTop: '0.6rem' }}>
            {filtered.length} of {rows.length} students
            {filtered.length > PAGE_SIZE ? ` — showing first ${PAGE_SIZE}, narrow your search for more` : ''}
          </p>

          <button
            className="button-secondary"
            style={{ marginTop: '0.8rem' }}
            onClick={() => setShowAddForm((v) => !v)}
          >
            {showAddForm ? 'Cancel' : '+ Add one student manually'}
          </button>

          {showAddForm && (
            <form
              onSubmit={handleAdd}
              style={{ marginTop: '0.8rem', padding: '1rem', border: '1px solid var(--line)', borderRadius: 4 }}
            >
              <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
                <input
                  style={{ flex: '1 1 140px' }}
                  placeholder="Reg. no."
                  value={addDraft.regNo}
                  onChange={(e) => setAddDraft((d) => ({ ...d, regNo: e.target.value }))}
                />
                <input
                  style={{ flex: '2 1 200px' }}
                  placeholder="Name"
                  value={addDraft.name}
                  onChange={(e) => setAddDraft((d) => ({ ...d, name: e.target.value }))}
                />
              </div>
              <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap', marginTop: '0.6rem' }}>
                <input
                  style={{ flex: '1 1 100px' }}
                  placeholder="Branch"
                  value={addDraft.branch}
                  onChange={(e) => setAddDraft((d) => ({ ...d, branch: e.target.value }))}
                />
                <input
                  style={{ flex: '1 1 100px' }}
                  placeholder="Section"
                  value={addDraft.section}
                  onChange={(e) => setAddDraft((d) => ({ ...d, section: e.target.value }))}
                />
                <input
                  style={{ flex: '1 1 120px' }}
                  type="number"
                  placeholder="Admission year"
                  value={addDraft.admissionYear}
                  onChange={(e) => setAddDraft((d) => ({ ...d, admissionYear: Number(e.target.value) }))}
                />
              </div>
              <button type="submit" disabled={adding} style={{ marginTop: '0.8rem' }}>
                {adding ? 'Adding…' : 'Add student'}
              </button>
            </form>
          )}

          <div style={{ marginTop: '1.2rem' }}>
            {displayed.length === 0 && (
              <p style={{ color: 'var(--ink-soft)' }}>No students match this search.</p>
            )}
            {displayed.map((row) => {
              const editing = editingRegNo === row.regNo;
              const busy = busyRegNo === row.regNo;
              return (
                <div key={row.regNo} className="list-row" style={{ padding: '0.8rem 0', borderBottom: '1px solid var(--line)' }}>
                  {editing ? (
                    <div>
                      <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: '0.75rem', color: 'var(--ink-soft)' }}>
                        {row.regNo}
                      </div>
                      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.4rem' }}>
                        <input
                          style={{ flex: '2 1 160px' }}
                          value={editDraft.name}
                          onChange={(e) => setEditDraft((d) => ({ ...d, name: e.target.value }))}
                        />
                        <input
                          style={{ flex: '1 1 90px' }}
                          value={editDraft.branch}
                          onChange={(e) => setEditDraft((d) => ({ ...d, branch: e.target.value }))}
                        />
                        <input
                          style={{ flex: '1 1 90px' }}
                          value={editDraft.section}
                          onChange={(e) => setEditDraft((d) => ({ ...d, section: e.target.value }))}
                        />
                        <input
                          style={{ flex: '1 1 110px' }}
                          type="number"
                          value={editDraft.admissionYear}
                          onChange={(e) => setEditDraft((d) => ({ ...d, admissionYear: Number(e.target.value) }))}
                        />
                      </div>
                      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.6rem' }}>
                        <button disabled={busy} onClick={() => saveEdit(row.regNo)}>
                          {busy ? 'Saving…' : 'Save'}
                        </button>
                        <button className="button-secondary" onClick={() => setEditingRegNo(null)}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div>
                        <div style={{ fontWeight: 500 }}>{row.name}</div>
                        <div className="eyebrow" style={{ fontSize: '0.65rem' }}>
                          {row.regNo} · {row.branch} / {row.section} · {row.admissionYear}
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

export default RosterBrowser;
