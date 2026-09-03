import { useState, useEffect, useMemo } from 'react';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { db } from './firebaseConfig';

type RosterEntry = {
  regNo: string;
  name: string;
  branch: string;
  section: string;
  admissionYear: number;
};

type GradeDoc = {
  studentEnrollmentNumber: string;
  studentName: string;
  credits: number;
  grade: string;
};

// Kept identical to the mobile app's own GRADE_POINTS (gradesService.ts)
// so a student's official Transcript screen and this class overview
// always agree on what a grade is worth.
const GRADE_POINTS: Record<string, number> = {
  AA: 10,
  AB: 9,
  BB: 8,
  BC: 7,
  CC: 6,
  CD: 5,
  DD: 4,
  FF: 0,
};

type StudentCgpa = {
  regNo: string;
  name: string;
  cgpa: number | null;
  subjectsGraded: number;
};

function ClassCGPA() {
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [dataLoading, setDataLoading] = useState(true);

  useEffect(() => {
    getDocs(collection(db, 'roster')).then((snap) => {
      setRoster(snap.docs.map((d) => ({ regNo: d.id, ...(d.data() as Omit<RosterEntry, 'regNo'>) })));
      setDataLoading(false);
    });
  }, []);

  const [admissionYear, setAdmissionYear] = useState('');
  const [branch, setBranch] = useState('');
  const [section, setSection] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<StudentCgpa[] | null>(null);

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

  const handleLoadClass = async () => {
    if (!admissionYear || !branch) {
      setStatus('Pick Admission Year and Branch first.');
      return;
    }
    setLoading(true);
    setStatus('');
    setResults(null);
    try {
      const sectionValue = section === '(no section)' ? null : section || null;
      // One query for the whole class rather than one per student —
      // grades already carry branch/section/admissionYear on every doc
      // (see AssignGrades.tsx's write payload), so this scales to a
      // class of any size in a single round trip.
      const constraints = [
        where('branch', '==', branch),
        where('admissionYear', '==', Number(admissionYear)),
      ];
      if (sectionValue !== null) constraints.push(where('section', '==', sectionValue));
      const snap = await getDocs(query(collection(db, 'grades'), ...constraints));

      const byStudent = new Map<string, GradeDoc[]>();
      snap.forEach((docSnap) => {
        const data = docSnap.data() as GradeDoc;
        const list = byStudent.get(data.studentEnrollmentNumber) ?? [];
        list.push(data);
        byStudent.set(data.studentEnrollmentNumber, list);
      });

      const classRoster = roster.filter(
        (r) => String(r.admissionYear) === admissionYear && r.branch === branch && (!section || (r.section || '(no section)') === section),
      );

      // Every roster student is listed, even ones with zero grades yet
      // (shown as "no grades entered" rather than silently omitted) —
      // a class list that quietly drops ungraded students would look
      // like it's missing people, not like grading is incomplete.
      const computed: StudentCgpa[] = classRoster.map((student) => {
        const grades = byStudent.get(student.regNo) ?? [];
        const totalCredits = grades.reduce((sum, g) => sum + g.credits, 0);
        const totalPoints = grades.reduce((sum, g) => sum + g.credits * (GRADE_POINTS[g.grade] ?? 0), 0);
        return {
          regNo: student.regNo,
          name: student.name,
          cgpa: totalCredits > 0 ? Math.round((totalPoints / totalCredits) * 100) / 100 : null,
          subjectsGraded: grades.length,
        };
      });
      computed.sort((a, b) => (b.cgpa ?? -1) - (a.cgpa ?? -1));

      setResults(computed);
      setStatus(`${computed.length} student(s) in this class — ${computed.filter((c) => c.cgpa !== null).length} have at least one grade entered.`);
    } catch (err: any) {
      setStatus(`Couldn't load: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  if (dataLoading) {
    return (
      <div className="card" style={{ width: 640, padding: '2.5rem', margin: '3rem auto' }}>
        <p>Loading roster...</p>
      </div>
    );
  }

  return (
    <div className="card" style={{ width: 640, padding: '2.5rem', margin: '3rem auto' }}>
      <h1 style={{ fontSize: '1.5rem' }}>Class CGPA</h1>
      <p style={{ fontSize: '0.85rem', color: 'var(--ink-soft)' }}>
        CGPA here is calculated live from every grade currently entered for each student — it's
        not a separate stored number, so it always matches exactly what shows on a student's own
        Transcript screen in the app. A student who's only had one subject graded so far will
        show that subject's grade as their CGPA until more subjects are entered — that's expected,
        not a bug.
      </p>

      <div style={{ display: 'flex', gap: '1rem', marginTop: '1.5rem' }}>
        <div style={{ flex: 1 }}>
          <label>Admission Year</label>
          <select value={admissionYear} onChange={(e) => { setAdmissionYear(e.target.value); setBranch(''); setSection(''); setResults(null); }}>
            <option value="">Select...</option>
            {admissionYears.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
        <div style={{ flex: 1 }}>
          <label>Branch</label>
          <select value={branch} disabled={!admissionYear} onChange={(e) => { setBranch(e.target.value); setSection(''); setResults(null); }}>
            <option value="">Select...</option>
            {branches.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
        <div style={{ flex: 1 }}>
          <label>Section (optional — leave blank for all)</label>
          <select value={section} disabled={!branch} onChange={(e) => { setSection(e.target.value); setResults(null); }}>
            <option value="">All sections</option>
            {sections.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      </div>

      <button onClick={handleLoadClass} disabled={loading} style={{ width: '100%', marginTop: '1rem' }}>
        {loading ? 'Loading...' : 'Load Class CGPA'}
      </button>

      {status && <p style={{ marginTop: '1rem', fontSize: '0.9rem' }}>{status}</p>}

      {results && (
        <div style={{ marginTop: '1.5rem' }}>
          <div style={{ display: 'flex', fontWeight: 700, fontSize: '0.85rem', padding: '0.5rem 0.7rem', borderBottom: '2px solid var(--line)' }}>
            <span style={{ flex: 2 }}>Name</span>
            <span style={{ flex: 1 }}>Reg No</span>
            <span style={{ width: 90, textAlign: 'right' }}>CGPA</span>
            <span style={{ width: 110, textAlign: 'right' }}>Subjects Graded</span>
          </div>
          {results.map((r) => (
            <div
              key={r.regNo}
              style={{ display: 'flex', fontSize: '0.85rem', padding: '0.5rem 0.7rem', borderBottom: '1px solid var(--line)' }}
            >
              <span style={{ flex: 2 }}>{r.name}</span>
              <span style={{ flex: 1, color: 'var(--ink-soft)' }}>{r.regNo}</span>
              <span style={{ width: 90, textAlign: 'right', fontWeight: 600 }}>{r.cgpa !== null ? r.cgpa.toFixed(2) : '—'}</span>
              <span style={{ width: 110, textAlign: 'right', color: 'var(--ink-soft)' }}>{r.subjectsGraded}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default ClassCGPA;
