import { useState, useEffect, useMemo } from 'react';
import { collection, getDocs, doc, setDoc, serverTimestamp } from 'firebase/firestore';
import { db, auth } from './firebaseConfig';

type RosterEntry = {
  regNo: string;
  name: string;
  branch: string;
  section: string;
  admissionYear: number;
};

type CurriculumEntry = {
  branch: string;
  semester: number;
  code: string;
  name: string;
  credits?: number;
};

type StudentMark = {
  regNo: string;
  name: string;
  total: number | null;
};

const GRADES = ['AA', 'AB', 'BB', 'BC', 'CC', 'CD', 'DD'] as const;
type GradeKey = (typeof GRADES)[number];

const HEADER_ALIASES = {
  enrollmentNumber: ['enrollmentnumber', 'enrollmentno', 'regno', 'regno.', 'rollno', 'registrationnumber'],
  name: ['name', 'studentname', 'fullname'],
  total: ['total', 'totalmarks', 'finalmarks', 'grandtotal'],
};

function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[\s._/()-]/g, '');
}
function headerMatchesField(normalizedHeader: string, aliases: string[]): boolean {
  return aliases.some((alias) => normalizedHeader.includes(alias));
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
function stdDev(values: number[], avg: number): number {
  return Math.sqrt(values.reduce((sum, v) => sum + (v - avg) ** 2, 0) / values.length);
}

function AssignGrades() {
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [curriculum, setCurriculum] = useState<CurriculumEntry[]>([]);
  const [dataLoading, setDataLoading] = useState(true);

  const [admissionYear, setAdmissionYear] = useState('');
  const [branch, setBranch] = useState('');
  const [section, setSection] = useState('');
  const [semester, setSemester] = useState('');
  const [subjectCode, setSubjectCode] = useState('');

  const [status, setStatus] = useState('');
  const [marks, setMarks] = useState<StudentMark[] | null>(null);
  const [absentTokens, setAbsentTokens] = useState<string[]>([]);

  const [cutoffs, setCutoffs] = useState<Record<GradeKey, string>>({
    AA: '', AB: '', BB: '', BC: '', CC: '', CD: '', DD: '',
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([getDocs(collection(db, 'roster')), getDocs(collection(db, 'curriculum'))])
      .then(([rosterSnap, curriculumSnap]) => {
        setRoster(rosterSnap.docs.map((d) => ({ regNo: d.id, ...(d.data() as Omit<RosterEntry, 'regNo'>) })));
        setCurriculum(curriculumSnap.docs.map((d) => d.data() as CurriculumEntry));
      })
      .finally(() => setDataLoading(false));
  }, []);

  const admissionYears = useMemo(() => Array.from(new Set(roster.map((r) => r.admissionYear))).sort((a, b) => b - a), [roster]);
  const branches = useMemo(
    () => Array.from(new Set(roster.filter((r) => String(r.admissionYear) === admissionYear).map((r) => r.branch))).sort(),
    [roster, admissionYear],
  );
  const sections = useMemo(
    () =>
      Array.from(
        new Set(roster.filter((r) => String(r.admissionYear) === admissionYear && r.branch === branch).map((r) => r.section || '(no section)')),
      ).sort(),
    [roster, admissionYear, branch],
  );
  const semesters = useMemo(
    () => Array.from(new Set(curriculum.filter((c) => c.branch === branch).map((c) => c.semester))).sort((a, b) => a - b),
    [curriculum, branch],
  );
  const subjects = useMemo(() => curriculum.filter((c) => c.branch === branch && String(c.semester) === semester), [curriculum, branch, semester]);
  const selectedSubject = subjects.find((s) => s.code === subjectCode);

  const handleFile = async (file: File) => {
    if (!admissionYear || !branch || !section || !subjectCode) {
      setStatus('Pick Admission Year, Branch, Section, and Subject first.');
      return;
    }
    setStatus('Reading file...');
    setMarks(null);
    const XLSX = await import('xlsx');
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: 'array' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1 });

    let headerRowIndex = -1;
    let regNoCol = -1;
    let nameCol = -1;
    let totalCol = -1;
    for (let i = 0; i < Math.min(rows.length, 10); i++) {
      const candidate = rows[i].map((h) => normalizeHeader(String(h ?? '')));
      const rCol = candidate.findIndex((h) => headerMatchesField(h, HEADER_ALIASES.enrollmentNumber));
      const nCol = candidate.findIndex((h) => headerMatchesField(h, HEADER_ALIASES.name));
      const tCol = candidate.findIndex((h) => headerMatchesField(h, HEADER_ALIASES.total));
      if (rCol !== -1 && nCol !== -1 && tCol !== -1) {
        headerRowIndex = i;
        regNoCol = rCol;
        nameCol = nCol;
        totalCol = tCol;
        break;
      }
    }

    if (headerRowIndex === -1) {
      setStatus('Could not find Reg No / Name / Total columns in the first 10 rows.');
      return;
    }

    const parsed: StudentMark[] = [];
    const absent: string[] = [];
    for (const row of rows.slice(headerRowIndex + 1)) {
      if (!row || row.every((c) => c === undefined || c === '')) continue;
      const regNo = String(row[regNoCol] ?? '').trim().toUpperCase();
      const name = String(row[nameCol] ?? '').trim();
      if (!regNo || !name) continue;

      const rawTotal = row[totalCol];
      const numTotal = typeof rawTotal === 'number' ? rawTotal : parseFloat(String(rawTotal));
      if (isNaN(numTotal) || numTotal < 0) {
        parsed.push({ regNo, name, total: null });
        absent.push(`${regNo} (${name})`);
      } else {
        parsed.push({ regNo, name, total: numTotal });
      }
    }

    if (parsed.length === 0) {
      setStatus('No valid student rows found.');
      return;
    }

    setMarks(parsed);
    setAbsentTokens(absent);
    setStatus(`Parsed ${parsed.length} students (${absent.length} absent/no-score, excluded from statistics below).`);
  };

  const validMarks = useMemo(() => (marks ?? []).filter((m) => m.total !== null).map((m) => m.total as number), [marks]);
  const stats = useMemo(() => {
    if (validMarks.length === 0) return null;
    const avg = mean(validMarks);
    return {
      mean: avg,
      median: median(validMarks),
      stdDev: stdDev(validMarks, avg),
      min: Math.min(...validMarks),
      max: Math.max(...validMarks),
      count: validMarks.length,
    };
  }, [validMarks]);

  const gradeCounts = useMemo(() => {
    if (!marks) return null;
    const counts: Record<string, number> = { AA: 0, AB: 0, BB: 0, BC: 0, CC: 0, CD: 0, DD: 0, FF: 0 };
    const numericCutoffs = GRADES.map((g) => ({ grade: g, min: parseFloat(cutoffs[g]) })).filter((c) => !isNaN(c.min));
    numericCutoffs.sort((a, b) => b.min - a.min);

    for (const m of marks) {
      if (m.total === null) {
        counts.FF++;
        continue;
      }
      const match = numericCutoffs.find((c) => m.total! >= c.min);
      counts[match ? match.grade : 'FF']++;
    }
    return counts;
  }, [marks, cutoffs]);

  const allCutoffsFilled = GRADES.every((g) => cutoffs[g].trim() !== '' && !isNaN(parseFloat(cutoffs[g])));

  const handleSave = async () => {
    if (!marks || !selectedSubject || !allCutoffsFilled) return;
    if (
      !confirm(
        `Save grades for ${marks.length} students in ${subjectCode.trim()}? ${gradeCounts?.FF ?? 0} will be marked FF (absent/no-score or below the DD cutoff). This overwrites any existing grade for each student in this subject.`,
      )
    )
      return;

    setSaving(true);
    setStatus('Saving...');
    try {
      const numericCutoffs = GRADES.map((g) => ({ grade: g, min: parseFloat(cutoffs[g]) })).sort((a, b) => b.min - a.min);
      const enteredBy = auth.currentUser?.uid ?? 'web-portal';
      const enteredByName = auth.currentUser?.email ?? 'Web Portal';
      const sectionValue = section === '(no section)' ? null : section;

      for (const m of marks) {
        const rosterEntry = roster.find((r) => r.regNo === m.regNo);
        let grade: string;
        if (m.total === null) {
          grade = 'FF';
        } else {
          const match = numericCutoffs.find((c) => m.total! >= c.min);
          grade = match ? match.grade : 'FF';
        }

        const id = `${m.regNo}_${subjectCode.trim()}`;
        await setDoc(doc(db, 'grades', id), {
          studentEnrollmentNumber: m.regNo,
          studentName: rosterEntry?.name ?? m.name,
          studentUid: null,
          branch: branch.trim(),
          section: sectionValue,
          admissionYear: Number(admissionYear),
          subjectCode: subjectCode.trim(),
          subjectName: selectedSubject.name,
          subjectSemester: Number(semester),
          credits: selectedSubject.credits ?? 0,
          grade,
          enteredBy,
          enteredByName,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
      setStatus(`Saved grades for ${marks.length} students.`);
    } catch (err: any) {
      setStatus(`Save failed: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  if (dataLoading) {
    return (
      <div className="card" style={{ width: 720, padding: '2.5rem', margin: '3rem auto' }}>
        <p>Loading roster and curriculum...</p>
      </div>
    );
  }

  return (
    <div className="card" style={{ width: 720, padding: '2.5rem', margin: '3rem auto' }}>
      <h1 style={{ fontSize: '1.5rem' }}>Assign Grades from Marks</h1>
      <p style={{ fontSize: '0.85rem', color: 'var(--ink-soft)' }}>
        Upload your marksheet (Reg No, Name, and a Total column — your own weighting formula for
        components like Midsem/Endsem stays in your sheet, this just reads the final Total). You
        decide every grade cutoff yourself — nothing here is auto-suggested.
      </p>

      <div style={{ display: 'flex', gap: '1rem', marginTop: '1.5rem' }}>
        <div style={{ flex: 1 }}>
          <label>Admission Year</label>
          <select value={admissionYear} onChange={(e) => { setAdmissionYear(e.target.value); setBranch(''); setSection(''); setMarks(null); }}>
            <option value="">Select...</option>
            {admissionYears.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
        <div style={{ flex: 1 }}>
          <label>Branch</label>
          <select value={branch} disabled={!admissionYear} onChange={(e) => { setBranch(e.target.value); setSection(''); setSemester(''); setSubjectCode(''); setMarks(null); }}>
            <option value="">Select...</option>
            {branches.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
        <div style={{ flex: 1 }}>
          <label>Section</label>
          <select value={section} disabled={!branch} onChange={(e) => { setSection(e.target.value); setMarks(null); }}>
            <option value="">Select...</option>
            {sections.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '1rem', marginTop: '1rem' }}>
        <div style={{ flex: 1 }}>
          <label>Semester</label>
          <select value={semester} disabled={!branch} onChange={(e) => { setSemester(e.target.value); setSubjectCode(''); setMarks(null); }}>
            <option value="">Select...</option>
            {semesters.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div style={{ flex: 2 }}>
          <label>Subject</label>
          <select value={subjectCode} disabled={!semester} onChange={(e) => { setSubjectCode(e.target.value); setMarks(null); }}>
            <option value="">Select...</option>
            {subjects.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
          </select>
        </div>
      </div>

      <div style={{ marginTop: '1rem' }}>
        <label>Marksheet (.xlsx)</label>
        <input
          type="file"
          accept=".xlsx,.xls"
          disabled={!subjectCode}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
        />
      </div>

      {status && <p style={{ marginTop: '1rem', fontSize: '0.9rem' }}>{status}</p>}

      {absentTokens.length > 0 && (
        <p style={{ fontSize: '0.8rem', color: '#b45309', marginTop: '0.5rem' }}>
          Absent/no-score (excluded from stats, will be marked FF): {absentTokens.join(', ')}
        </p>
      )}

      {stats && (
        <div style={{ marginTop: '1.5rem', padding: '1rem', background: 'var(--panel-bg, #f5f5f5)', borderRadius: 6 }}>
          <strong style={{ fontSize: '0.9rem' }}>Class Distribution ({stats.count} students with a valid score)</strong>
          <div style={{ display: 'flex', gap: '1.5rem', marginTop: '0.5rem', fontSize: '0.85rem' }}>
            <span>Mean: <strong>{stats.mean.toFixed(1)}</strong></span>
            <span>Median: <strong>{stats.median.toFixed(1)}</strong></span>
            <span>Std Dev: <strong>{stats.stdDev.toFixed(1)}</strong></span>
            <span>Min: <strong>{stats.min}</strong></span>
            <span>Max: <strong>{stats.max}</strong></span>
          </div>
        </div>
      )}

      {marks && (
        <>
          <h3 style={{ marginTop: '1.5rem', fontSize: '1.1rem' }}>Set Grade Cutoffs (minimum score for each grade)</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '0.5rem', marginTop: '0.5rem' }}>
            {GRADES.map((g) => (
              <div key={g}>
                <label style={{ fontSize: '0.8rem' }}>{g}</label>
                <input
                  type="number"
                  value={cutoffs[g]}
                  onChange={(e) => setCutoffs((prev) => ({ ...prev, [g]: e.target.value }))}
                  placeholder="e.g. 37"
                />
              </div>
            ))}
          </div>

          {gradeCounts && (
            <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1rem', flexWrap: 'wrap' }}>
              {[...GRADES, 'FF' as const].map((g) => (
                <div
                  key={g}
                  style={{
                    padding: '0.4rem 0.8rem',
                    borderRadius: 999,
                    background: g === 'FF' ? '#fee2e2' : '#e0f2fe',
                    fontSize: '0.85rem',
                    fontWeight: 600,
                  }}
                >
                  {g}: {gradeCounts[g]}
                </div>
              ))}
            </div>
          )}

          <button onClick={handleSave} disabled={saving || !allCutoffsFilled} style={{ width: '100%', marginTop: '1.5rem' }}>
            {saving ? 'Saving...' : allCutoffsFilled ? `Save Grades for ${marks.length} Students` : 'Fill in all 7 cutoffs to save'}
          </button>
        </>
      )}
    </div>
  );
}

export default AssignGrades;
