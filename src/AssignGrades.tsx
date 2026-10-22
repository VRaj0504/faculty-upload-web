import BrandLoader from './BrandLoader';
import { useState, useEffect, useMemo } from 'react';
import { collection, getDocs, doc, writeBatch, serverTimestamp, query, where, Timestamp } from 'firebase/firestore';
import { db, auth } from './firebaseConfig';
import { gradesTemplate } from './xlsxTemplates';
import { curriculum as staticCurriculum } from './curriculum';
import { COURSE_CREDITS } from './curriculumCredits';
import SegmentedControl from './SegmentedControl';
import MarksTable, { type TableMark } from './MarksTable';

const ALL_BRANCHES = ['CSE', 'ECE', 'MNC'];

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
  const [mode, setMode] = useState<'table' | 'excel'>('table');

  const [admissionYear, setAdmissionYear] = useState('');
  const [branch, setBranch] = useState('');
  const [section, setSection] = useState('');
  const [semester, setSemester] = useState('');
  const [subjectCode, setSubjectCode] = useState('');

  const [status, setStatus] = useState('');
  const [marks, setMarks] = useState<StudentMark[] | null>(null);
  const [absentTokens, setAbsentTokens] = useState<string[]>([]);

  const [statsRevealed, setStatsRevealed] = useState(false);

  const [cutoffs, setCutoffs] = useState<Record<GradeKey, string>>({
    AA: '', AB: '', BB: '', BC: '', CC: '', CD: '', DD: '',
  });
  const [saving, setSaving] = useState(false);

  const [overrides, setOverrides] = useState<Record<string, string>>({});

  useEffect(() => {
    Promise.all([getDocs(collection(db, 'roster')), getDocs(collection(db, 'curriculum'))])
      .then(([rosterSnap, curriculumSnap]) => {
        setRoster(
          rosterSnap.docs
            .filter((d) => d.data().reviewer !== true)
            .map((d) => ({ regNo: d.id, ...(d.data() as Omit<RosterEntry, 'regNo'>) })),
        );
        setCurriculum(curriculumSnap.docs.map((d) => d.data() as CurriculumEntry));
      })
      .finally(() => setDataLoading(false));
  }, []);

  const admissionYears = useMemo(() => Array.from(new Set(roster.map((r) => r.admissionYear))).sort((a, b) => b - a), [roster]);
  const branches = useMemo(
    () =>
      Array.from(
        new Set([...ALL_BRANCHES, ...roster.filter((r) => String(r.admissionYear) === admissionYear).map((r) => r.branch)]),
      ).sort(),
    [roster, admissionYear],
  );
  const sections = useMemo(
    () =>
      Array.from(
        new Set(roster.filter((r) => String(r.admissionYear) === admissionYear && r.branch === branch).map((r) => r.section || '(no section)')),
      ).sort(),
    [roster, admissionYear, branch],
  );

  const fullCurriculum = useMemo(() => {
    const have = new Set(curriculum.map((c) => `${c.branch}|${c.semester}`));
    const extra: CurriculumEntry[] = [];
    for (const [b, bySem] of Object.entries(staticCurriculum)) {
      for (const [sem, list] of Object.entries(bySem)) {
        if (have.has(`${b}|${sem}`)) continue;
        for (const c of list) extra.push({ branch: b, semester: Number(sem), code: c.code, name: c.name, credits: COURSE_CREDITS[c.code] });
      }
    }
    return [...curriculum, ...extra];
  }, [curriculum]);
  const semesters = useMemo(
    () => Array.from(new Set(fullCurriculum.filter((c) => c.branch === branch).map((c) => c.semester))).sort((a, b) => a - b),
    [fullCurriculum, branch],
  );
  const subjects = useMemo(
    () => fullCurriculum.filter((c) => c.branch === branch && String(c.semester) === semester),
    [fullCurriculum, branch, semester],
  );
  const selectedSubject = subjects.find((s) => s.code === subjectCode);

  const classRoster = useMemo(
    () =>
      roster.filter(
        (r) =>
          String(r.admissionYear) === admissionYear &&
          r.branch === branch &&
          (section === '(no section)' ? !r.section : r.section === section),
      ),
    [roster, admissionYear, branch, section],
  );

  const tableStudents = useMemo(
    () => classRoster.map((r) => ({ regNo: r.regNo.toUpperCase(), name: r.name })),
    [classRoster],
  );
  const [notInClass, setNotInClass] = useState<StudentMark[]>([]);
  const [missingFromSheet, setMissingFromSheet] = useState<RosterEntry[]>([]);

  useEffect(() => {
    setNotInClass([]);
    setMissingFromSheet([]);
  }, [admissionYear, branch, section, subjectCode]);

  const downloadTemplate = () => {
    if (!selectedSubject) return;
    gradesTemplate({
      students: classRoster.map((r) => ({ regNo: r.regNo, name: r.name })),
      branch,
      section,
      admissionYear,
      subjectCode: selectedSubject.code,
      subjectName: selectedSubject.name,
    }).catch((e) => setStatus(`Couldn't make the template: ${e.message}`));
  };

  const [pendingWorkbook, setPendingWorkbook] = useState<any>(null);
  const [pendingSheetNames, setPendingSheetNames] = useState<string[]>([]);

  const handleFile = async (file: File) => {
    if (!admissionYear || !branch || !section || !subjectCode) {
      setStatus('Pick Admission Year, Branch, Section, and Subject first.');
      return;
    }
    setStatus('Reading file...');
    setMarks(null);
    setNotInClass([]);
    setMissingFromSheet([]);
    setPendingWorkbook(null);
    try {
      const XLSX = await import('xlsx');
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array' });

      const marksSheets = workbook.SheetNames.filter((name: string) => {
        const rows: any[][] = XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1 });
        return rows.slice(0, 10).some((row) => {
          const cells = Array.from({ length: row?.length ?? 0 }, (_, i) => normalizeHeader(String(row[i] ?? '')));

          const r = cells.findIndex((h) => headerMatchesField(h, HEADER_ALIASES.enrollmentNumber));
          const n = cells.findIndex((h, i) => i !== r && headerMatchesField(h, HEADER_ALIASES.name));
          const t = cells.findIndex((h, i) => i !== r && i !== n && headerMatchesField(h, HEADER_ALIASES.total));
          return r !== -1 && n !== -1 && t !== -1;
        });
      });
      if (marksSheets.length === 1) {
        parseSheet(XLSX, workbook, marksSheets[0]);
        return;
      }

      if (workbook.SheetNames.length > 1) {

        setPendingWorkbook(workbook);
        setPendingSheetNames(workbook.SheetNames);
        setStatus(`This file has ${workbook.SheetNames.length} sheets — pick which one is ${branch} ${section} below.`);
        return;
      }

      parseSheet(XLSX, workbook, workbook.SheetNames[0]);
    } catch (err: any) {
      setStatus(`Couldn't read this file: ${err.message ?? 'unknown error'}. Make sure it's a real .xlsx/.xls file, not corrupted or renamed from another format.`);
    }
  };

  const onTableMarks = (list: TableMark[] | null, absent: string[]) => {
    setMarks(list);
    setAbsentTokens(absent);
    if (list) {
      setNotInClass([]);
      setMissingFromSheet([]);
    }
  };

  const handlePickSheet = async (sheetName: string) => {
    if (!pendingWorkbook) return;
    try {
      const XLSX = await import('xlsx');
      parseSheet(XLSX, pendingWorkbook, sheetName);
      setPendingWorkbook(null);
      setPendingSheetNames([]);
    } catch (err: any) {
      setStatus(`Couldn't read that sheet: ${err.message ?? 'unknown error'}.`);
    }
  };

  function parseSheet(XLSX: any, workbook: any, sheetName: string) {
    const sheet = workbook.Sheets[sheetName];
    const rows: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1 });

    let headerRowIndex = -1;
    let regNoCol = -1;
    let nameCol = -1;
    let totalCol = -1;
    for (let i = 0; i < Math.min(rows.length, 10); i++) {
      const candidate = rows[i].map((h) => normalizeHeader(String(h ?? '')));

      const filled = Array.from({ length: candidate.length }, (_, idx) => candidate[idx] ?? '');
      const rCol = filled.findIndex((h) => headerMatchesField(h, HEADER_ALIASES.enrollmentNumber));
      const nCol = filled.findIndex((h) => headerMatchesField(h, HEADER_ALIASES.name));
      const tCol = filled.findIndex((h) => headerMatchesField(h, HEADER_ALIASES.total));
      if (rCol !== -1 && nCol !== -1 && tCol !== -1 && new Set([rCol, nCol, tCol]).size === 3) {
        headerRowIndex = i;
        regNoCol = rCol;
        nameCol = nCol;
        totalCol = tCol;
        break;
      }
    }

    if (headerRowIndex === -1) {
      setStatus(`Could not find Reg No / Name / Total columns in the first 10 rows of "${sheetName}".`);
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
      setStatus(`No valid student rows found in "${sheetName}".`);
      return;
    }

    const inClass = new Set(classRoster.map((r) => r.regNo.toUpperCase()));
    const known = classRoster.length ? parsed.filter((m) => inClass.has(m.regNo)) : parsed;
    const strangers = classRoster.length ? parsed.filter((m) => !inClass.has(m.regNo)) : [];
    const onSheet = new Set(parsed.map((m) => m.regNo));
    const missing = classRoster.filter((r) => !onSheet.has(r.regNo.toUpperCase()));
    setNotInClass(strangers);
    setMissingFromSheet(missing);

    if (known.length === 0) {
      setMarks(null);
      setStatus(
        `None of the ${parsed.length} Enrollment Numbers in "${sheetName}" belong to ${branch} ${section} (admitted ${admissionYear}). Is this the right sheet?`,
      );
      return;
    }

    setMarks(known);
    setAbsentTokens(absent.filter((t) => known.some((m) => t.startsWith(m.regNo + ' '))));
    setStatus(
      `Read ${known.length} students from "${sheetName}" (${known.filter((m) => m.total === null).length} absent/no-score, excluded from statistics below).`,
    );
  }

  const validMarks = useMemo(() => (marks ?? []).filter((m) => m.total !== null).map((m) => m.total as number), [marks]);

  useEffect(() => {
    if (mode === 'excel') setStatsRevealed(false);
  }, [marks, mode]);

  const gradeDraftKey = `gradeDraft:${admissionYear}|${branch}|${section}|${subjectCode}`;
  const [gradeDraftLoaded, setGradeDraftLoaded] = useState('');
  useEffect(() => {
    if (!admissionYear || !branch || !section || !subjectCode) return;
    try {
      const saved = JSON.parse(localStorage.getItem(gradeDraftKey) ?? 'null');
      if (saved?.cutoffs) setCutoffs((prev) => ({ ...prev, ...saved.cutoffs }));
      else setCutoffs({ AA: '', AB: '', BB: '', BC: '', CC: '', CD: '', DD: '' });
      setOverrides(saved?.overrides ?? {});
    } catch {

    }
    setGradeDraftLoaded(gradeDraftKey);
  }, [gradeDraftKey]);
  useEffect(() => {
    if (gradeDraftLoaded !== gradeDraftKey) return;
    try {
      localStorage.setItem(gradeDraftKey, JSON.stringify({ cutoffs, overrides }));
    } catch {

    }
  }, [cutoffs, overrides, gradeDraftKey, gradeDraftLoaded]);

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

  const numericCutoffs = useMemo(
    () => GRADES.map((g) => ({ grade: g, min: parseFloat(cutoffs[g]) })).filter((c) => !isNaN(c.min)).sort((a, b) => b.min - a.min),
    [cutoffs],
  );

  const gradeFor = (total: number | null): string | null => {
    if (total === null) return numericCutoffs.length ? 'FF' : null;
    if (!numericCutoffs.length) return null;
    return numericCutoffs.find((c) => total >= c.min)?.grade ?? 'FF';
  };
  const finalGrade = (regNo: string, total: number | null): string =>
    overrides[regNo] ?? gradeFor(total) ?? 'FF';

  const gradeCounts = useMemo(() => {
    if (!marks) return null;
    const counts: Record<string, number> = { AA: 0, AB: 0, BB: 0, BC: 0, CC: 0, CD: 0, DD: 0, FF: 0 };
    for (const m of marks) counts[finalGrade(m.regNo, m.total)]++;
    return counts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marks, numericCutoffs, overrides]);

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
      const enteredBy = auth.currentUser?.uid ?? 'web-portal';
      const enteredByName = auth.currentUser?.email ?? 'Web Portal';
      const sectionValue = section === '(no section)' ? null : section;
      const existingSnap = await getDocs(
        query(collection(db, 'grades'), where('subjectCode', '==', subjectCode.trim()), where('admissionYear', '==', Number(admissionYear))),
      );
      const existingById = new Map(existingSnap.docs.map((d) => [d.id, d.data() as Record<string, any>]));

      const CHUNK = 400;
      for (let i = 0; i < marks.length; i += CHUNK) {
        const batch = writeBatch(db);
        for (const m of marks.slice(i, i + CHUNK)) {
          const rosterEntry = roster.find((r) => r.regNo === m.regNo);
          const grade = finalGrade(m.regNo, m.total);

          const id = `${m.regNo}_${subjectCode.trim()}`;
          const prev = existingById.get(id);
          const history = [...((prev?.history as unknown[]) ?? [])];
          const prevAttempt = prev?.attempt ?? 'regular';
          if (prev?.grade && prev.grade !== grade && prevAttempt !== 'regular') {
            history.push({ grade: prev.grade, attempt: prevAttempt, enteredByName: prev.enteredByName ?? null, changedAt: Timestamp.now() });
          }
          batch.set(doc(db, 'grades', id), {
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
            attempt: 'regular',
            history,
            enteredBy,
            enteredByName,
            createdAt: prev?.createdAt ?? serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        }
        await batch.commit();
      }
      setStatus(`Saved grades for ${marks.length} students.`);
    } catch (err: any) {
      setStatus(`Save failed: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const cutoffsPanel = (
    <div id="grade-cutoffs" style={{ marginTop: '1.25rem' }}>
      <h3 style={{ fontSize: '1.05rem', margin: 0 }}>Grade cutoffs <span style={{ fontWeight: 500, fontSize: '0.8rem', color: 'var(--ink-soft)' }}>— minimum Total for each grade</span></h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: '0.5rem', marginTop: '0.5rem' }}>
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
    </div>
  );

  if (dataLoading) {
    return (
      <div className="card" style={{ width: 720, padding: '2.5rem', margin: '3rem auto' }}>
        <BrandLoader label="Loading roster and curriculum…" />
      </div>
    );
  }

  return (
    <div className="card" style={{ width: mode === 'table' ? 1040 : 720, maxWidth: '100%', padding: '2.5rem', margin: '3rem auto' }}>
      <h1 style={{ fontSize: '1.5rem' }}>Assign Grades from Marks</h1>
      <p style={{ fontSize: '0.85rem', color: 'var(--ink-soft)' }}>
        Enter the marks right here in a ready-made table (quizzes, mid sem, end sem), or upload an Excel
        sheet with Enrollment No, Name and a Total column. Either way you decide every grade cutoff
        yourself — nothing here is auto-suggested.
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

      <div style={{ marginTop: '1.5rem' }}>
        <SegmentedControl<'table' | 'excel'>
          size="sm"
          options={[
            { value: 'table', label: 'Enter marks here' },
            { value: 'excel', label: 'Upload Excel' },
          ]}
          value={mode}
          onChange={(m) => {
            setMode(m);
            setMarks(null);
            setNotInClass([]);
            setMissingFromSheet([]);
            setAbsentTokens([]);
            setStatus('');
          }}
        />
      </div>

      {mode === 'table' && (
        subjectCode && admissionYear && branch && section ? (
          <MarksTable
            students={tableStudents}
            draftKey={`${admissionYear}|${branch}|${section}|${subjectCode}`}
            onMarks={onTableMarks}
            gradeFor={gradeFor}
            overrides={overrides}
            onOverride={(regNo, g) =>
              setOverrides((prev) => {
                const next = { ...prev };
                if (g) next[regNo] = g;
                else delete next[regNo];
                return next;
              })
            }
            aboveTable={cutoffsPanel}
          />
        ) : (
          <p className="res-hint" style={{ marginTop: '1rem' }}>
            Pick the admission year, branch, section and subject above — the table fills with that class's students.
          </p>
        )
      )}

      {mode === 'excel' && (
      <div className="grade-upload">
        <div className="grade-upload-step">
          <span className="res-step-num">1</span>
          <div style={{ flex: 1 }}>
            <strong>Download the marks template</strong>
            <p>
              {subjectCode
                ? `An Excel sheet already listing all ${classRoster.length} students of ${section.toUpperCase().startsWith(branch.toUpperCase()) ? section : `${branch} ${section}`} — fill only the Total column (AB for absent).`
                : 'Pick the class and subject above first — the template comes pre-filled with that class\'s students.'}
            </p>
          </div>
          <button type="button" className="button-secondary" disabled={!subjectCode || classRoster.length === 0} onClick={downloadTemplate}>
            Download Excel template
          </button>
        </div>
        <div className="grade-upload-step">
          <span className="res-step-num">2</span>
          <div style={{ flex: 1 }}>
            <strong>Upload the filled sheet</strong>
            <p>Columns read: Enrollment No, Name, Total. Your own extra columns are ignored.</p>
            <input
              type="file"
              accept=".xlsx,.xls"
              disabled={!subjectCode}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ''; }}
              style={{ marginTop: '0.5rem' }}
            />
          </div>
        </div>
      </div>
      )}

      {pendingSheetNames.length > 0 && (
        <div style={{ marginTop: '1rem', padding: '1rem', background: 'var(--panel-bg, #f5f5f5)', borderRadius: 6 }}>
          <label>Which sheet is {branch} {section}?</label>
          <select defaultValue="" onChange={(e) => e.target.value && handlePickSheet(e.target.value)}>
            <option value="" disabled>
              Select the matching sheet...
            </option>
            {pendingSheetNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
      )}

      {status && <p style={{ marginTop: '1rem', fontSize: '0.9rem' }}>{status}</p>}

      {notInClass.length > 0 && (
        <div className="notice notice-error" style={{ display: 'block' }}>
          <strong>{notInClass.length} row{notInClass.length === 1 ? '' : 's'} skipped — not in {branch} {section}:</strong>{' '}
          {notInClass.map((m) => `${m.regNo} (${m.name})`).join(', ')}. Check for a typo in the Enrollment No.
        </div>
      )}
      {missingFromSheet.length > 0 && (
        <div className="notice" style={{ display: 'block', background: 'var(--tone-yellow-bg)', color: 'var(--tone-yellow-fg)' }}>
          <strong>{missingFromSheet.length} student{missingFromSheet.length === 1 ? '' : 's'} of this class {missingFromSheet.length === 1 ? 'is' : 'are'} not on the sheet</strong>{' '}
          and won't get a grade: {missingFromSheet.map((r) => `${r.regNo} (${r.name})`).join(', ')}.
        </div>
      )}

      {absentTokens.length > 0 && (
        <p style={{ fontSize: '0.8rem', color: '#b45309', marginTop: '0.5rem' }}>
          Absent/no-score (excluded from stats, will be marked FF): {absentTokens.join(', ')}
        </p>
      )}

      {stats && !statsRevealed && (
        <button
          onClick={() => setStatsRevealed(true)}
          className="button-secondary"
          style={{ marginTop: '1.5rem' }}
        >
          Show Class Statistics ({stats.count} students with a valid score)
        </button>
      )}

      {stats && statsRevealed && (
        <div style={{ marginTop: '1.5rem', padding: '1rem', background: 'var(--panel-bg, #f5f5f5)', borderRadius: 6 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <strong style={{ fontSize: '0.9rem' }}>Class Distribution ({stats.count} students with a valid score)</strong>
            <button onClick={() => setStatsRevealed(false)} className="button-secondary" style={{ fontSize: '0.78rem', padding: '0.2rem 0.6rem' }}>
              Hide
            </button>
          </div>
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
          {mode === 'excel' && cutoffsPanel}

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
