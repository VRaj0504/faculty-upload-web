import { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { collection, getDocs, doc, setDoc, deleteDoc, query, where, limit } from 'firebase/firestore';
import { db } from './firebaseConfig';
import { useExamAccess } from './ExamCell';
import StudentAcademics from './StudentAcademics';

type RosterRow = {
  regNo: string;
  name: string;
  branch: string;
  section: string;
  admissionYear: number;

  program?: 'UG' | 'PG';
  specialization?: string;
};

type StudentAccount = {
  email?: string;
  phone?: string;
};

const PAGE_SIZE = 200;

function getCurrentSemester(admissionYear: number, today: Date = new Date(), program: 'UG' | 'PG' = 'UG'): number {
  const currentMonth = today.getMonth() + 1;
  const currentYear = today.getFullYear();
  const isOddSemesterPeriod = currentMonth >= 7;
  const academicYearIndex = isOddSemesterPeriod
    ? currentYear - admissionYear
    : currentYear - admissionYear - 1;
  const semester = academicYearIndex * 2 + 1 + (isOddSemesterPeriod ? 0 : 1);
  const totalSemesters = program === 'PG' ? 4 : 8;
  return Math.min(Math.max(semester, 1), totalSemesters);
}

function RosterBrowser({ email, role }: { email: string; role: string | null }) {
  const access = useExamAccess(email, role);
  const [rows, setRows] = useState<RosterRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [search, setSearch] = useState('');
  const [branchFilter, setBranchFilter] = useState<string>('All');
  const [yearFilter, setYearFilter] = useState<string>('All');
  const [programFilter, setProgramFilter] = useState<string>('All');
  const [semFilter, setSemFilter] = useState<string>('All');

  const [previewRow, setPreviewRow] = useState<RosterRow | null>(null);
  const [previewAccount, setPreviewAccount] = useState<StudentAccount | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [closingPreview, setClosingPreview] = useState(false);

  const [editingRegNo, setEditingRegNo] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Omit<RosterRow, 'regNo'>>({
    name: '',
    branch: '',
    section: '',
    admissionYear: new Date().getFullYear(),
  });
  const [busyRegNo, setBusyRegNo] = useState<string | null>(null);

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
    const relevant = programFilter === 'All' ? rows : rows.filter((r) => (r.program ?? 'UG') === programFilter);
    const set = new Set(relevant.map((r) => r.branch).filter(Boolean));
    return ['All', ...Array.from(set).sort()];
  }, [rows, programFilter]);

  const years = useMemo(() => {
    const set = new Set(rows.map((r) => r.admissionYear).filter(Boolean));
    return ['All', ...Array.from(set).sort((a, b) => b - a).map(String)];
  }, [rows]);

  const programs = useMemo(() => {
    const hasPg = rows.some((r) => r.program === 'PG');
    return hasPg ? ['All', 'UG', 'PG'] : ['All'];
  }, [rows]);

  const semesters = useMemo(() => {
    const max = programFilter === 'PG' ? 4 : 8;
    return ['All', ...Array.from({ length: max }, (_, i) => String(i + 1))];
  }, [programFilter]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (branchFilter !== 'All' && r.branch !== branchFilter) return false;
      if (yearFilter !== 'All' && String(r.admissionYear) !== yearFilter) return false;
      if (programFilter !== 'All' && (r.program ?? 'UG') !== programFilter) return false;
      if (semFilter !== 'All' && String(getCurrentSemester(r.admissionYear, undefined, r.program)) !== semFilter) return false;
      if (!q) return true;
      return r.regNo.toLowerCase().includes(q) || r.name.toLowerCase().includes(q);
    });
  }, [rows, search, branchFilter, yearFilter, programFilter, semFilter]);

  const displayed = filtered.slice(0, PAGE_SIZE);

  const openPreview = async (row: RosterRow) => {
    setPreviewRow(row);
    setClosingPreview(false);
    setPreviewAccount(null);
    setPreviewError('');
    setPreviewLoading(true);
    try {
      const q = query(collection(db, 'users'), where('enrollmentNumber', '==', row.regNo), limit(1));
      const snap = await getDocs(q);
      setPreviewAccount(snap.empty ? null : (snap.docs[0].data() as StudentAccount));
    } catch (err: any) {
      setPreviewError(`Could not load contact details: ${err.message}`);
    } finally {
      setPreviewLoading(false);
    }
  };

  const closePreview = () => {
    setClosingPreview(true);
    setTimeout(() => {
      setPreviewRow(null);
      setClosingPreview(false);
    }, 220);
  };

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
      await setDoc(
        doc(db, 'roster', regNo),
        {
          name: editDraft.name.trim(),
          branch: editDraft.branch.trim().toUpperCase(),
          section: editDraft.section.trim(),
          admissionYear: Number(editDraft.admissionYear),
        },
        { merge: true },
      );
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
          <h1 style={{ fontSize: '1.5rem' }}>Browse Students</h1>
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
                        <select style={{ flex: '1 1 140px' }} value={branchFilter} onChange={(e) => setBranchFilter(e.target.value)}>
              {branches.map((b) => (
                <option key={b} value={b}>{b === 'All' ? 'All branches' : b}</option>
              ))}
            </select>
            <select style={{ flex: '1 1 140px' }} value={yearFilter} onChange={(e) => setYearFilter(e.target.value)}>
              {years.map((y) => (
                <option key={y} value={y}>{y === 'All' ? 'All years' : `Admitted ${y}`}</option>
              ))}
            </select>
            {programs.length > 1 && (
              <select
                style={{ flex: '1 1 140px' }}
                value={programFilter}
                onChange={(e) => {

                  setProgramFilter(e.target.value);
                  setBranchFilter('All');
                  setSemFilter('All');
                }}
              >
                {programs.map((p) => (
                  <option key={p} value={p}>{p === 'All' ? 'All programs' : p}</option>
                ))}
              </select>
            )}
            <select style={{ flex: '1 1 140px' }} value={semFilter} onChange={(e) => setSemFilter(e.target.value)}>
              {semesters.map((s) => (
                <option key={s} value={s}>{s === 'All' ? 'All semesters' : `Semester ${s}`}</option>
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
                <select
                  style={{ flex: '1 1 100px' }}
                  value={addDraft.branch}
                  onChange={(e) => setAddDraft((d) => ({ ...d, branch: e.target.value, section: '' }))}
                >
                  <option value="">Branch…</option>
                  {Array.from(new Set(['CSE', 'ECE', 'MNC', ...rows.map((r) => r.branch).filter(Boolean)])).sort().map((b) => (
                    <option key={b} value={b}>{b}</option>
                  ))}
                </select>
                <select
                  style={{ flex: '1 1 120px' }}
                  value={addDraft.admissionYear}
                  onChange={(e) => setAddDraft((d) => ({ ...d, admissionYear: Number(e.target.value), section: '' }))}
                >
                  {Array.from(new Set([new Date().getFullYear(), ...rows.map((r) => r.admissionYear).filter(Boolean)]))
                    .sort((a, b) => b - a)
                    .map((y) => <option key={y} value={y}>Admitted {y}</option>)}
                </select>
                <select
                  style={{ flex: '1 1 120px' }}
                  value={addDraft.section}
                  disabled={!addDraft.branch}
                  onChange={(e) => setAddDraft((d) => ({ ...d, section: e.target.value }))}
                >
                  <option value="">Section…</option>
                  {Array.from(
                    new Set(
                      rows
                        .filter((r) => r.branch === addDraft.branch && r.admissionYear === addDraft.admissionYear)
                        .map((r) => r.section)
                        .filter(Boolean),
                    ),
                  )
                    .sort()
                    .map((sec) => <option key={sec} value={sec}>{sec}</option>)}
                </select>
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
                        <select
                          style={{ flex: '1 1 90px' }}
                          value={editDraft.branch}
                          onChange={(e) => setEditDraft((d) => ({ ...d, branch: e.target.value, section: '' }))}
                        >
                          {Array.from(new Set(['CSE', 'ECE', 'MNC', ...rows.map((r) => r.branch).filter(Boolean), editDraft.branch].filter(Boolean))).sort().map((br) => (
                            <option key={br} value={br}>{br}</option>
                          ))}
                        </select>
                        <select
                          style={{ flex: '1 1 110px' }}
                          value={editDraft.section}
                          onChange={(e) => setEditDraft((d) => ({ ...d, section: e.target.value }))}
                        >
                          <option value="">No section</option>
                          {Array.from(
                            new Set(
                              [
                                ...rows
                                  .filter((r) => r.branch === editDraft.branch && r.admissionYear === editDraft.admissionYear)
                                  .map((r) => r.section),
                                editDraft.section,
                              ].filter(Boolean),
                            ),
                          )
                            .sort()
                            .map((sec) => <option key={sec} value={sec}>{sec}</option>)}
                        </select>
                        <select
                          style={{ flex: '1 1 110px' }}
                          value={editDraft.admissionYear}
                          onChange={(e) => setEditDraft((d) => ({ ...d, admissionYear: Number(e.target.value), section: '' }))}
                        >
                          {Array.from(new Set([new Date().getFullYear(), editDraft.admissionYear, ...rows.map((r) => r.admissionYear).filter(Boolean)]))
                            .sort((x, y) => y - x)
                            .map((yr) => <option key={yr} value={yr}>Admitted {yr}</option>)}
                        </select>
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
                      <div
                        style={{ cursor: 'pointer' }}
                        onClick={() => openPreview(row)}
                        title="View student details"
                      >
                        <div style={{ fontWeight: 500 }}>{row.name}</div>
                        <div className="eyebrow" style={{ fontSize: '0.65rem' }}>
                          {row.regNo} · {row.branch} / {row.program === 'PG' ? `PG ${row.section}` : row.section} · Sem {getCurrentSemester(row.admissionYear, undefined, row.program)} · Admitted {row.admissionYear}
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

      {previewRow && createPortal(
        <div
          className={`drawer-overlay${closingPreview ? ' drawer-closing' : ''}`}
          onClick={closePreview}
        >
          <div
            className={`drawer-panel${closingPreview ? ' drawer-panel-closing' : ''}`}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <h2 style={{ fontSize: '1.2rem', margin: 0 }}>{previewRow.name}</h2>
              <button className="button-secondary" onClick={closePreview}>
                Close
              </button>
            </div>

            <div style={{ marginTop: '1.6rem', display: 'flex', flexDirection: 'column', gap: '1.1rem' }}>
              <div>
                <div className="eyebrow" style={{ fontSize: '0.65rem' }}>Roll No.</div>
                <div style={{ fontSize: '1.05rem' }}>{previewRow.regNo}</div>
              </div>
              <div>
                <div className="eyebrow" style={{ fontSize: '0.65rem' }}>Branch / Section</div>
                <div style={{ fontSize: '1.05rem' }}>{previewRow.branch} / {previewRow.section}</div>
              </div>
              <div>
                <div className="eyebrow" style={{ fontSize: '0.65rem' }}>Year</div>
                <div style={{ fontSize: '1.05rem' }}>
                  Semester {getCurrentSemester(previewRow.admissionYear, undefined, previewRow.program)} · Admitted {previewRow.admissionYear}
                </div>
              </div>
              <div>
                <div className="eyebrow" style={{ fontSize: '0.65rem' }}>Email</div>
                <div style={{ fontSize: '1.05rem' }}>
                  {previewLoading
                    ? 'Loading…'
                    : previewAccount?.email ?? 'Not yet registered in the app'}
                </div>
              </div>
              <div>
                <div className="eyebrow" style={{ fontSize: '0.65rem' }}>Contact</div>
                <div style={{ fontSize: '1.05rem' }}>
                  {previewLoading
                    ? 'Loading…'
                    : previewAccount?.phone ?? 'Not shared'}
                </div>
              </div>
              {previewError && <p className="error-text">{previewError}</p>}
              <div style={{ borderTop: '1px solid var(--line)', paddingTop: '1rem' }}>
                <div className="eyebrow" style={{ fontSize: '0.65rem', marginBottom: '0.5rem' }}>Academic record</div>
                {access.loading ? (
                  <p className="res-hint">Loading…</p>
                ) : access.full || access.hodBranches.includes(previewRow.branch) ? (
                  <StudentAcademics regNo={previewRow.regNo} admissionYear={previewRow.admissionYear} />
                ) : (
                  <p className="res-hint">CGPA, grades and backlogs are visible to the exam cell, admins and this student's HOD.</p>
                )}
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

export default RosterBrowser;