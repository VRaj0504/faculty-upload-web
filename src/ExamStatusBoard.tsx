import { Fragment, useEffect, useMemo, useState } from 'react';
import { evaluateStudent, type ExamStatus, GRADE_LABELS } from './examRules';
import { groupByStudent, loadGrades, loadRoster, type RosterRow } from './examData';
import { downloadXlsx } from './xlsxTemplates';

type Row = { student: RosterRow; status: ExamStatus };
type Filter = 'all' | 'backlogs' | 'risk' | 'pending';

const STANDING_LABEL: Record<ExamStatus['standing'], string> = {
  'no-results': 'No results',
  clear: 'Clear',
  backlogs: 'Backlogs',
  'at-risk': 'At risk',
};

const STANDING_COLOR: Record<ExamStatus['standing'], string> = {
  'no-results': 'var(--ink-soft)',
  clear: '#15803D',
  backlogs: '#9A4A0F',
  'at-risk': '#B42318',
};

export default function ExamStatusBoard({ branchesAllowed }: { branchesAllowed: string[] | null }) {
  const [roster, setRoster] = useState<RosterRow[]>([]);
  const [rosterLoading, setRosterLoading] = useState(true);
  const [batch, setBatch] = useState('');
  const [branch, setBranch] = useState('');
  const [section, setSection] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    loadRoster()
      .then(setRoster)
      .catch((e) => setError(`Couldn't load students: ${e.message}`))
      .finally(() => setRosterLoading(false));
  }, []);

  const batches = useMemo(() => Array.from(new Set(roster.map((r) => r.admissionYear))).filter(Boolean).sort((a, b) => b - a), [roster]);
  const branches = useMemo(() => {
    const all = Array.from(new Set(roster.filter((r) => String(r.admissionYear) === batch).map((r) => r.branch))).sort();
    return branchesAllowed ? all.filter((b) => branchesAllowed.includes(b)) : all;
  }, [roster, batch, branchesAllowed]);
  const sections = useMemo(
    () => Array.from(new Set(roster.filter((r) => String(r.admissionYear) === batch && r.branch === branch).map((r) => r.section ?? ''))).filter(Boolean).sort(),
    [roster, batch, branch],
  );

  const load = async () => {
    if (!batch || !branch) {
      setError('Pick a batch and branch first.');
      return;
    }
    setError('');
    setLoading(true);
    setRows(null);
    try {
      const grades = await loadGrades(Number(batch), branch);
      const byStudent = groupByStudent(grades);
      const students = roster.filter((r) => String(r.admissionYear) === batch && r.branch === branch);
      const computed = students
        .map((student) => ({ student, status: evaluateStudent(byStudent.get(student.regNo) ?? [], student.admissionYear) }))
        .sort((a, b) => a.student.regNo.localeCompare(b.student.regNo));
      setRows(computed);
    } catch (e: any) {
      setError(`Couldn't load results: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  const visible = useMemo(() => {
    if (!rows) return [];
    return rows.filter((r) => {
      if (section && r.student.section !== section) return false;
      if (filter === 'backlogs') return r.status.counts.total > 0;
      if (filter === 'risk') return r.status.standing === 'at-risk';
      if (filter === 'pending') return r.status.counts.pending > 0;
      return true;
    });
  }, [rows, section, filter]);

  const summary = useMemo(() => {
    const scoped = (rows ?? []).filter((r) => !section || r.student.section === section);
    return {
      total: scoped.length,
      withResults: scoped.filter((r) => r.status.standing !== 'no-results').length,
      backlogs: scoped.filter((r) => r.status.counts.total > 0).length,
      risk: scoped.filter((r) => r.status.standing === 'at-risk').length,
      yearBack: scoped.filter((r) => r.status.yearBack).length,
      pending: scoped.filter((r) => r.status.counts.pending > 0).length,
    };
  }, [rows, section]);

  const exportExcel = async () => {
    if (!rows) return;
    const head = ['Enrollment No', 'Name', 'Section', 'Year', 'CGPA', 'Earned credits', 'Supplementary', 'Repeat', 'Incomplete (II)', 'Standing', 'Year back risk', 'Warnings'];
    const statusRows = visible.map((r) => [
      r.student.regNo,
      r.student.name,
      r.student.section ?? '',
      r.status.yearOfStudy,
      r.status.cgpa ?? '',
      r.status.earnedCredits,
      r.status.counts.supplementary,
      r.status.counts.repeat,
      r.status.counts.pending,
      STANDING_LABEL[r.status.standing],
      r.status.yearBack ? 'Yes' : '',
      r.status.alerts.map((a) => a.title).join('; '),
    ]);
    const backlogRows = visible.flatMap((r) =>
      r.status.backlogs.map((b) => [
        r.student.regNo,
        r.student.name,
        r.student.section ?? '',
        b.subjectCode,
        b.subjectName,
        b.semester,
        b.grade,
        b.kind === 'supplementary' ? 'Supplementary exam' : b.kind === 'repeat' ? 'Repeat course' : 'Incomplete',
        b.attempts,
      ]),
    );
    await downloadXlsx(`exam-status-${branch}-${batch}${section ? `-${section}` : ''}.xlsx`, [
      { name: 'Status', rows: [head, ...statusRows], widths: [14, 28, 8, 6, 7, 9, 9, 8, 9, 10, 9, 60] },
      {
        name: 'Backlogs',
        rows: [['Enrollment No', 'Name', 'Section', 'Subject Code', 'Subject', 'Semester', 'Grade', 'Needs', 'Attempts'], ...backlogRows],
        widths: [14, 28, 8, 12, 36, 9, 7, 18, 9],
      },
    ]);
  };

  if (rosterLoading) return <div className="card" style={{ padding: '2rem', margin: '2rem auto', maxWidth: 960 }}>Loading students…</div>;

  return (
    <div style={{ maxWidth: 1040, margin: '0 auto', padding: '1rem 0 3rem' }}>
      <h1 style={{ fontSize: '1.5rem', margin: '0 0 0.3rem' }}>Student exam status</h1>
      <p style={{ color: 'var(--ink-soft)', margin: '0 0 1rem', fontSize: '0.9rem' }}>
        Backlogs, year-back risk and credit checks, worked out from the grades in CollegeGo using the B.Tech Academic Ordinance
        (FF/NA → supplementary, XX/WW/ZZ → repeat, more than 3 uncleared courses in a year → year back, minimum earned credits by year).
      </p>

      <div className="card" style={{ padding: '1.2rem 1.4rem' }}>
        <div className="att-row" style={{ marginTop: 0 }}>
          <div className="att-field">
            <label>Batch (admission year)</label>
            <select value={batch} onChange={(e) => { setBatch(e.target.value); setBranch(''); setSection(''); setRows(null); }}>
              <option value="">Select…</option>
              {batches.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
          <div className="att-field">
            <label>Branch</label>
            <select value={branch} disabled={!batch} onChange={(e) => { setBranch(e.target.value); setSection(''); setRows(null); }}>
              <option value="">Select…</option>
              {branches.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>
          <div className="att-field">
            <label>Section</label>
            <select value={section} disabled={!branch} onChange={(e) => setSection(e.target.value)}>
              <option value="">All sections</option>
              {sections.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="att-field">
            <label>Show</label>
            <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
              <option value="all">All students</option>
              <option value="backlogs">With backlogs</option>
              <option value="risk">At risk (year back / credits)</option>
              <option value="pending">With II (incomplete)</option>
            </select>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.6rem', marginTop: '1rem', flexWrap: 'wrap' }}>
          <button onClick={load} disabled={loading || !batch || !branch}>{loading ? 'Loading…' : 'Load results'}</button>
          {rows && <button className="button-secondary" onClick={exportExcel}>Download Excel</button>}
        </div>
        {branchesAllowed && <p className="res-hint">As HOD you see {branchesAllowed.join(', ')} only.</p>}
        {error && <p className="error-text" style={{ marginTop: '0.8rem' }}>{error}</p>}
      </div>

      {rows && (
        <>
          <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap', margin: '1rem 0' }}>
            {[
              ['Students', summary.total],
              ['With results', summary.withResults],
              ['With backlogs', summary.backlogs],
              ['At risk', summary.risk],
              ['Year back risk', summary.yearBack],
              ['With II', summary.pending],
            ].map(([label, n]) => (
              <div key={label as string} className="card" style={{ padding: '0.6rem 1rem', minWidth: 110 }}>
                <div style={{ fontSize: '1.3rem', fontWeight: 800 }}>{n}</div>
                <div style={{ fontSize: '0.8rem', color: 'var(--ink-soft)' }}>{label}</div>
              </div>
            ))}
          </div>

          <div className="card" style={{ padding: '0.4rem 0.8rem', overflowX: 'auto' }}>
            <table className="att-table" style={{ marginTop: 0 }}>
              <thead>
                <tr>
                  <th>Enrollment</th>
                  <th>Name</th>
                  <th>Sec</th>
                  <th>CGPA</th>
                  <th>Earned</th>
                  <th>Supp.</th>
                  <th>Repeat</th>
                  <th>II</th>
                  <th>Standing</th>
                </tr>
              </thead>
              <tbody>
                {visible.length === 0 && (
                  <tr>
                    <td colSpan={9} style={{ color: 'var(--ink-soft)' }}>No students match this filter.</td>
                  </tr>
                )}
                {visible.map((r) => {
                  const isOpen = open === r.student.regNo;
                  return (
                    <Fragment key={r.student.regNo}>
                      <tr onClick={() => setOpen(isOpen ? null : r.student.regNo)} style={{ cursor: 'pointer' }}>
                        <td>{r.student.regNo}</td>
                        <td>{r.student.name}</td>
                        <td>{r.student.section ?? ''}</td>
                        <td>{r.status.cgpa?.toFixed(2) ?? '—'}</td>
                        <td>{r.status.earnedCredits}</td>
                        <td style={{ color: r.status.counts.supplementary ? '#B42318' : undefined, fontWeight: r.status.counts.supplementary ? 700 : undefined }}>{r.status.counts.supplementary}</td>
                        <td style={{ color: r.status.counts.repeat ? '#B42318' : undefined, fontWeight: r.status.counts.repeat ? 700 : undefined }}>{r.status.counts.repeat}</td>
                        <td>{r.status.counts.pending}</td>
                        <td style={{ color: STANDING_COLOR[r.status.standing], fontWeight: 700 }}>
                          {STANDING_LABEL[r.status.standing]}
                          {r.status.yearBack ? ' · year back' : ''}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr>
                          <td colSpan={9} style={{ background: 'var(--panel-bg)' }}>
                            {r.status.alerts.length === 0 && r.status.backlogs.length === 0 && (
                              <span style={{ color: 'var(--ink-soft)' }}>
                                {r.status.standing === 'no-results' ? 'No grades entered yet.' : 'No backlogs or warnings.'}
                              </span>
                            )}
                            {r.status.alerts.map((a, i) => (
                              <div key={i} style={{ marginBottom: '0.4rem' }}>
                                <strong style={{ color: a.level === 'high' ? '#B42318' : a.level === 'medium' ? '#9A4A0F' : undefined }}>{a.title}</strong>
                                <span style={{ color: 'var(--ink-soft)' }}> · {a.rule}</span>
                                <div style={{ fontSize: '0.82rem' }}>{a.detail}</div>
                              </div>
                            ))}
                            {r.status.backlogs.length > 0 && (
                              <ul style={{ margin: '0.4rem 0 0', paddingLeft: '1.1rem' }}>
                                {r.status.backlogs.map((b) => (
                                  <li key={b.subjectCode}>
                                    <strong>{b.subjectCode}</strong> {b.subjectName} · Sem {b.semester} · {b.grade} ({GRADE_LABELS[b.grade] ?? b.grade})
                                    {b.attempts > 1 ? ` · attempt ${b.attempts}` : ''}
                                  </li>
                                ))}
                              </ul>
                            )}
                            {r.status.creditTarget && (
                              <div style={{ fontSize: '0.82rem', color: 'var(--ink-soft)', marginTop: '0.4rem' }}>
                                Year {r.status.creditTarget.year}: {r.status.creditTarget.earned} / {r.status.creditTarget.needed} earned credits
                                {r.status.creditTarget.checked ? '' : ' (earlier semesters not fully recorded)'}
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
