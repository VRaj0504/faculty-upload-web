import { useEffect, useMemo, useState } from 'react';
import { ALL_GRADES, ATTEMPT_LABELS, ATTEMPT_TYPES, type AttemptType } from './examRules';
import {
  composeGradeDoc,
  gradeDocId,
  loadGrades,
  loadRoster,
  loadSubjectIndex,
  subjectKey,
  writeGradeDocs,
  type GradeDoc,
  type RosterRow,
  type SubjectInfo,
} from './examData';
import { downloadXlsx, readSheetRows } from './xlsxTemplates';

type ParsedRow = {
  line: number;
  regNo: string;
  code: string;
  grade: string;
  student: RosterRow | null;
  subject: SubjectInfo | null;
  error: string | null;
  change: 'new' | 'changed' | 'same' | null;
  previous: string | null;
};

const norm = (v: unknown) => String(v ?? '').trim();
const normCode = (v: unknown) => norm(v).toUpperCase().replace(/\s+/g, '');

export default function ResultUpload() {
  const [roster, setRoster] = useState<RosterRow[]>([]);
  const [subjects, setSubjects] = useState<Map<string, SubjectInfo>>(new Map());
  const [ready, setReady] = useState(false);
  const [batch, setBatch] = useState('');
  const [branch, setBranch] = useState('');
  const [attempt, setAttempt] = useState<AttemptType>('supplementary');
  const [rows, setRows] = useState<ParsedRow[] | null>(null);
  const [existing, setExisting] = useState<Map<string, GradeDoc>>(new Map());
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([loadRoster(), loadSubjectIndex()])
      .then(([r, s]) => {
        setRoster(r);
        setSubjects(s);
      })
      .catch((e) => setError(`Couldn't load data: ${e.message}`))
      .finally(() => setReady(true));
  }, []);

  const batches = useMemo(() => Array.from(new Set(roster.map((r) => r.admissionYear))).filter(Boolean).sort((a, b) => b - a), [roster]);
  const branches = useMemo(
    () => Array.from(new Set(roster.filter((r) => String(r.admissionYear) === batch).map((r) => r.branch))).sort(),
    [roster, batch],
  );
  const classRoster = useMemo(
    () => roster.filter((r) => String(r.admissionYear) === batch && r.branch === branch),
    [roster, batch, branch],
  );

  const downloadTemplate = async () => {
    if (!batch || !branch) return;
    const branchSubjects = Array.from(subjects.values())
      .filter((s) => s.branch === branch)
      .sort((a, b) => a.semester - b.semester || a.code.localeCompare(b.code));
    await downloadXlsx(`results-${branch}-${batch}.xlsx`, [
      {
        name: 'Results',
        rows: [['Enrollment No', 'Name', 'Subject Code', 'Grade'], ...classRoster.map((r) => [r.regNo, r.name, '', ''])],
        widths: [16, 30, 14, 8],
        textCols: [0, 2, 3],
      },
      {
        name: 'How to fill',
        rows: [
          ['How to fill this result sheet'],
          [],
          ['1. One row per student per subject. Copy a student\'s row if they have more than one subject.'],
          ['2. Subject Code must match the curriculum (see the Subjects sheet).'],
          [`3. Grade must be one of: ${ALL_GRADES.join(', ')}.`],
          ['4. You can also upload a wide sheet: Enrollment No, then one column per subject code with the grade in each cell.'],
          ['5. Leave rows blank to skip them. Only rows with a grade are saved.'],
        ],
        widths: [110],
      },
      {
        name: 'Subjects',
        rows: [['Semester', 'Subject Code', 'Subject Name', 'Credits'], ...branchSubjects.map((s) => [s.semester, s.code, s.name, s.credits ?? ''])],
        widths: [10, 14, 50, 9],
      },
    ]);
  };

  const parseFile = async (file: File) => {
    setError('');
    setStatus('');
    setRows(null);
    if (!batch || !branch) {
      setError('Pick the batch and branch first.');
      return;
    }
    let current: Map<string, GradeDoc>;
    try {
      const grades = await loadGrades(Number(batch), branch);
      current = new Map(grades.map((g) => [g.id, g]));
      setExisting(current);
    } catch (e: any) {
      setError(`Couldn't load existing grades: ${e.message}`);
      return;
    }
    const byReg = new Map(classRoster.map((r) => [r.regNo.toUpperCase(), r]));
    const result = await readSheetRows<ParsedRow[]>(file, (sheet) => {
      const headerIdx = sheet.findIndex((row) => row.some((c) => /enrol|reg/i.test(norm(c))));
      if (headerIdx < 0) return { error: 'No "Enrollment No" column found.' };
      const header = sheet[headerIdx].map((c) => norm(c));
      const regCol = header.findIndex((h) => /enrol|reg/i.test(h));
      const subjCol = header.findIndex((h) => /subject|course/i.test(h) && /code/i.test(h));
      const gradeCol = header.findIndex((h) => /^grade$/i.test(h));
      const out: ParsedRow[] = [];
      const push = (line: number, regRaw: unknown, codeRaw: unknown, gradeRaw: unknown) => {
        const regNo = norm(regRaw).toUpperCase();
        const code = normCode(codeRaw);
        const grade = norm(gradeRaw).toUpperCase();
        if (!regNo && !grade) return;
        if (!grade) return;
        const student = byReg.get(regNo) ?? null;
        const subject = subjects.get(subjectKey(branch, code)) ?? null;
        let err: string | null = null;
        if (!student) err = `${regNo || '(blank)'} isn't in ${branch} ${batch}`;
        else if (!subject) err = `Unknown subject code "${code}" for ${branch}`;
        else if (!subject.credits) err = `No credits on file for ${code}. Add them in Curriculum.`;
        else if (!ALL_GRADES.includes(grade)) err = `Invalid grade "${grade}"`;
        const id = student && subject ? gradeDocId(student.regNo, subject.code) : '';
        const prev = id ? current.get(id) : undefined;
        out.push({
          line,
          regNo,
          code,
          grade,
          student,
          subject,
          error: err,
          change: err ? null : !prev ? 'new' : prev.grade === grade ? 'same' : 'changed',
          previous: prev?.grade ?? null,
        });
      };
      if (subjCol >= 0 && gradeCol >= 0) {
        sheet.slice(headerIdx + 1).forEach((row, i) => push(headerIdx + i + 2, row[regCol], row[subjCol], row[gradeCol]));
      } else {
        const subjectCols = header
          .map((h, i) => ({ i, code: normCode(h) }))
          .filter((c) => c.i !== regCol && subjects.has(subjectKey(branch, c.code)));
        if (subjectCols.length === 0) return { error: 'No "Subject Code" + "Grade" columns, and no subject-code columns found.' };
        sheet.slice(headerIdx + 1).forEach((row, i) => subjectCols.forEach((c) => push(headerIdx + i + 2, row[regCol], c.code, row[c.i])));
      }
      if (out.length === 0) return { error: 'No rows with a grade found.' };
      return out;
    });
    if ('error' in result) {
      setError(result.error);
      return;
    }
    setRows(result.result);
  };

  const counts = useMemo(() => {
    const ok = (rows ?? []).filter((r) => !r.error);
    return {
      ok: ok.length,
      errors: (rows ?? []).filter((r) => r.error).length,
      fresh: ok.filter((r) => r.change === 'new').length,
      changed: ok.filter((r) => r.change === 'changed').length,
      same: ok.filter((r) => r.change === 'same').length,
    };
  }, [rows]);

  const save = async () => {
    if (!rows) return;
    const toWrite = rows.filter((r) => !r.error && r.change !== 'same' && r.student && r.subject);
    if (toWrite.length === 0) {
      setStatus('Nothing new to save.');
      return;
    }
    if (!confirm(`Save ${toWrite.length} result(s) as ${ATTEMPT_LABELS[attempt]}? Students are notified of changed grades.`)) return;
    setSaving(true);
    setStatus('Saving…');
    try {
      const items = toWrite.map((r) => {
        const id = gradeDocId(r.student!.regNo, r.subject!.code);
        return {
          id,
          data: composeGradeDoc(existing.get(id), {
            student: r.student!,
            subject: r.subject!,
            credits: r.subject!.credits!,
            grade: r.grade,
            attempt,
          }),
        };
      });
      await writeGradeDocs(items, (done) => setStatus(`Saving… ${done}/${items.length}`));
      setStatus(`Saved ${items.length} result(s). Earlier grades are kept in each student's history.`);
      setRows(null);
    } catch (e: any) {
      setStatus('');
      setError(`Save failed: ${e.message}. Only exam cell members and admins can upload results.`);
    } finally {
      setSaving(false);
    }
  };

  if (!ready) return <div className="card" style={{ padding: '2rem', margin: '2rem auto', maxWidth: 860 }}>Loading…</div>;

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: '1rem 0 3rem' }}>
      <h1 style={{ fontSize: '1.5rem', margin: '0 0 0.3rem' }}>Upload results</h1>
      <p style={{ color: 'var(--ink-soft)', margin: '0 0 1rem', fontSize: '0.9rem' }}>
        Upload the official result sheet for a batch: regular, supplementary or repeat. A changed grade keeps the old one in the
        student's history, so an FF cleared in the supplementary still shows as attempt 2.
      </p>

      <div className="card" style={{ padding: '1.2rem 1.4rem' }}>
        <div className="att-row" style={{ marginTop: 0 }}>
          <div className="att-field">
            <label>Batch (admission year)</label>
            <select value={batch} onChange={(e) => { setBatch(e.target.value); setBranch(''); setRows(null); }}>
              <option value="">Select…</option>
              {batches.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
          <div className="att-field">
            <label>Branch</label>
            <select value={branch} disabled={!batch} onChange={(e) => { setBranch(e.target.value); setRows(null); }}>
              <option value="">Select…</option>
              {branches.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>
          <div className="att-field">
            <label>Exam attempt</label>
            <select value={attempt} onChange={(e) => setAttempt(e.target.value as AttemptType)}>
              {ATTEMPT_TYPES.map((a) => <option key={a} value={a}>{ATTEMPT_LABELS[a]}</option>)}
            </select>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.6rem', marginTop: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="button-secondary" disabled={!batch || !branch} onClick={downloadTemplate}>Download template</button>
          <input
            type="file"
            accept=".xlsx,.xls,.csv"
            disabled={!batch || !branch}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) parseFile(f);
              e.target.value = '';
            }}
          />
        </div>
        <p className="res-hint">
          Columns: Enrollment No, Subject Code, Grade. Or a wide sheet with one column per subject code. Grades: {ALL_GRADES.join(', ')}.
        </p>
        {error && <p className="error-text" style={{ marginTop: '0.8rem' }}>{error}</p>}
        {status && <p className="notice notice-ok" style={{ marginTop: '0.8rem' }}>{status}</p>}
      </div>

      {rows && (
        <div className="card" style={{ padding: '1.2rem 1.4rem', marginTop: '1rem' }}>
          <p style={{ margin: 0, fontWeight: 600 }}>
            {counts.ok} ready ({counts.fresh} new, {counts.changed} changed, {counts.same} unchanged) · {counts.errors} with problems
          </p>
          {counts.errors > 0 && <p className="res-hint">Rows with problems are skipped. Fix them in the sheet and upload again if needed.</p>}
          <div style={{ overflowX: 'auto', maxHeight: 460, overflowY: 'auto' }}>
            <table className="att-table">
              <thead>
                <tr>
                  <th>Row</th>
                  <th>Enrollment</th>
                  <th>Name</th>
                  <th>Subject</th>
                  <th>Grade</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {[...rows].sort((a, b) => Number(!!b.error) - Number(!!a.error)).slice(0, 500).map((r, i) => (
                  <tr key={i}>
                    <td>{r.line}</td>
                    <td>{r.regNo}</td>
                    <td>{r.student?.name ?? ''}</td>
                    <td>{r.subject ? `${r.subject.code} · Sem ${r.subject.semester}` : r.code}</td>
                    <td style={{ fontWeight: 700 }}>{r.grade}</td>
                    <td style={{ color: r.error ? '#B42318' : r.change === 'changed' ? '#9A4A0F' : 'var(--ink-soft)' }}>
                      {r.error ?? (r.change === 'new' ? 'New' : r.change === 'changed' ? `Changed from ${r.previous}` : 'Unchanged')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button style={{ width: '100%', marginTop: '1rem' }} disabled={saving || counts.ok === 0} onClick={save}>
            {saving ? 'Saving…' : `Save ${counts.fresh + counts.changed} result(s) as ${ATTEMPT_LABELS[attempt]}`}
          </button>
        </div>
      )}
    </div>
  );
}
