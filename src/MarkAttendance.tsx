import { useState, useEffect, useMemo } from 'react';
import { collection, getDocs, doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
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
};

function todayDateString(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function sessionDocId(branch: string, admissionYear: number, section: string, subjectCode: string, date: string): string {
  return `${branch}_${admissionYear}_${section || 'NONE'}_${subjectCode}_${date}`;
}

function MarkAttendance() {
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [curriculum, setCurriculum] = useState<CurriculumEntry[]>([]);
  const [dataLoading, setDataLoading] = useState(true);
  const [dataError, setDataError] = useState('');

  const [admissionYear, setAdmissionYear] = useState('');
  const [branch, setBranch] = useState('');
  const [section, setSection] = useState('');
  const [semester, setSemester] = useState('');
  const [subjectCode, setSubjectCode] = useState('');
  const [date, setDate] = useState(todayDateString());

  const [loadedRoster, setLoadedRoster] = useState<RosterEntry[] | null>(null);
  const [loadingClass, setLoadingClass] = useState(false);
  const [status, setStatus] = useState('');
  const [absentSet, setAbsentSet] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([getDocs(collection(db, 'roster')), getDocs(collection(db, 'curriculum'))])
      .then(([rosterSnap, curriculumSnap]) => {
        setRoster(rosterSnap.docs.map((d) => ({ regNo: d.id, ...(d.data() as Omit<RosterEntry, 'regNo'>) })));
        setCurriculum(curriculumSnap.docs.map((d) => d.data() as CurriculumEntry));
      })
      .catch((err) => setDataError(`Couldn't load roster/curriculum: ${err.message}`))
      .finally(() => setDataLoading(false));
  }, []);

  const admissionYears = useMemo(
    () => Array.from(new Set(roster.map((r) => r.admissionYear))).sort((a, b) => b - a),
    [roster],
  );
  const branches = useMemo(
    () =>
      Array.from(
        new Set(roster.filter((r) => String(r.admissionYear) === admissionYear).map((r) => r.branch)),
      ).sort(),
    [roster, admissionYear],
  );
  const sections = useMemo(
    () =>
      Array.from(
        new Set(
          roster
            .filter((r) => String(r.admissionYear) === admissionYear && r.branch === branch)
            .map((r) => r.section || '(no section)'),
        ),
      ).sort(),
    [roster, admissionYear, branch],
  );
  const semesters = useMemo(
    () => Array.from(new Set(curriculum.filter((c) => c.branch === branch).map((c) => c.semester))).sort((a, b) => a - b),
    [curriculum, branch],
  );
  const subjects = useMemo(
    () => curriculum.filter((c) => c.branch === branch && String(c.semester) === semester),
    [curriculum, branch, semester],
  );

  const [rollInput, setRollInput] = useState('');
  const [rollInputFeedback, setRollInputFeedback] = useState('');

  // Type absentee roll numbers instead of scrolling and clicking — the
  // fast path for faculty reading off a paper list. Accepts full
  // enrollment numbers (UG25CSE114) or just the trailing digits (114),
  // separated by commas/spaces/newlines, since reading out "114, 117,
  // 132" is how it actually gets written on paper.
  const applyRollNumbers = () => {
    if (!loadedRoster) return;
    const tokens = rollInput
      .split(/[\s,]+/)
      .map((t) => t.trim().toUpperCase())
      .filter(Boolean);
    if (tokens.length === 0) {
      setRollInputFeedback('');
      return;
    }

    const matched = new Set<string>();
    const unmatched: string[] = [];

    for (const token of tokens) {
      // Exact full-enrollment match first, then a trailing-digits match
      // (so "114" finds UG25CSE114) — but only when that suffix is
      // unambiguous within this class, since silently picking one of two
      // possible students would be a genuinely bad failure here.
      const exact = loadedRoster.find((s) => s.regNo.toUpperCase() === token);
      if (exact) {
        matched.add(exact.regNo);
        continue;
      }
      const suffixMatches = loadedRoster.filter((s) => s.regNo.toUpperCase().endsWith(token));
      if (suffixMatches.length === 1) {
        matched.add(suffixMatches[0].regNo);
      } else {
        unmatched.push(token + (suffixMatches.length > 1 ? ' (ambiguous)' : ''));
      }
    }

    setAbsentSet(matched);
    setRollInputFeedback(
      unmatched.length > 0
        ? `Marked ${matched.size} absent. Couldn't match: ${unmatched.join(', ')} — check these and fix, or click them in the list below.`
        : `Marked ${matched.size} absent.`,
    );
  };

  const handleLoad = async () => {
    if (!admissionYear || !branch || !section || !subjectCode || !date) {
      setStatus('Pick every field above first.');
      return;
    }
    setLoadingClass(true);
    setStatus('');
    try {
      const sectionValue = section === '(no section)' ? '' : section;
      const matching = roster
        .filter(
          (r) =>
            String(r.admissionYear) === admissionYear &&
            r.branch === branch &&
            (r.section || '') === sectionValue,
        )
        .sort((a, b) => a.regNo.localeCompare(b.regNo));

      const id = sessionDocId(branch, Number(admissionYear), sectionValue, subjectCode, date);
      const existingSnap = await getDoc(doc(db, 'attendanceSessions', id));
      const existingAbsentees = existingSnap.exists()
        ? ((existingSnap.data().absentEnrollmentNumbers as string[]) ?? [])
        : [];

      setLoadedRoster(matching);
      setAbsentSet(new Set(existingAbsentees));
      setRollInput(existingAbsentees.slice().sort().join(', '));
      setRollInputFeedback('');
      setStatus(
        existingSnap.exists()
          ? `Loaded ${matching.length} students — this date was already marked, showing the existing record.`
          : `Loaded ${matching.length} students. Everyone starts Present — click a name to mark them Absent.`,
      );
    } catch (err: any) {
      setStatus(`Couldn't load class: ${err.message}`);
    } finally {
      setLoadingClass(false);
    }
  };

  const toggleAbsent = (regNo: string) => {
    setAbsentSet((prev) => {
      const next = new Set(prev);
      if (next.has(regNo)) next.delete(regNo);
      else next.add(regNo);
      // Keep the text box in sync when someone clicks a name instead of
      // typing — otherwise the two inputs would silently disagree and
      // whichever was touched last would win confusingly.
      setRollInput(Array.from(next).sort().join(', '));
      setRollInputFeedback('');
      return next;
    });
  };

  const handleSave = async () => {
    if (!loadedRoster) return;
    const subject = subjects.find((s) => s.code === subjectCode);
    if (!subject) return;
    if (
      !confirm(
        `Save attendance for ${subjectCode} on ${date}? ${loadedRoster.length - absentSet.size} present, ${absentSet.size} absent.`,
      )
    )
      return;
    setSaving(true);
    setStatus('Saving...');
    try {
      const sectionValue = section === '(no section)' ? '' : section;
      const id = sessionDocId(branch, Number(admissionYear), sectionValue, subjectCode, date);
      await setDoc(doc(db, 'attendanceSessions', id), {
        branch,
        admissionYear: Number(admissionYear),
        section: sectionValue || null,
        subjectCode,
        subjectName: subject.name,
        date,
        absentEnrollmentNumbers: Array.from(absentSet),
        markedBy: auth.currentUser?.uid ?? 'web-portal',
        markedAt: serverTimestamp(),
      });
      setStatus(`Saved — ${loadedRoster.length - absentSet.size} present, ${absentSet.size} absent.`);
    } catch (err: any) {
      setStatus(`Couldn't save: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  if (dataLoading) {
    return (
      <div className="card" style={{ width: 680, padding: '2.5rem', margin: '3rem auto' }}>
        <p>Loading roster and curriculum...</p>
      </div>
    );
  }

  if (dataError) {
    return (
      <div className="card" style={{ width: 680, padding: '2.5rem', margin: '3rem auto' }}>
        <p style={{ color: '#b91c1c' }}>{dataError}</p>
      </div>
    );
  }

  return (
    <div className="card" style={{ width: 680, padding: '2.5rem', margin: '3rem auto' }}>
      <h1 style={{ fontSize: '1.5rem' }}>Mark Attendance</h1>
      <p style={{ fontSize: '0.85rem', color: 'var(--ink-soft)' }}>
        Every field below is a dropdown built from real roster/curriculum data — nothing to type,
        nothing that can be spelled wrong.
      </p>

      <div style={{ display: 'flex', gap: '1rem', marginTop: '1.5rem' }}>
        <div style={{ flex: 1 }}>
          <label>Admission Year</label>
          <select
            value={admissionYear}
            onChange={(e) => {
              setAdmissionYear(e.target.value);
              setBranch('');
              setSection('');
              setLoadedRoster(null);
            }}
          >
            <option value="">Select...</option>
            {admissionYears.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </div>
        <div style={{ flex: 1 }}>
          <label>Branch</label>
          <select
            value={branch}
            disabled={!admissionYear}
            onChange={(e) => {
              setBranch(e.target.value);
              setSection('');
              setSemester('');
              setSubjectCode('');
              setLoadedRoster(null);
            }}
          >
            <option value="">Select...</option>
            {branches.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </div>
        <div style={{ flex: 1 }}>
          <label>Section</label>
          <select
            value={section}
            disabled={!branch}
            onChange={(e) => {
              setSection(e.target.value);
              setLoadedRoster(null);
            }}
          >
            <option value="">Select...</option>
            {sections.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '1rem', marginTop: '1rem' }}>
        <div style={{ flex: 1 }}>
          <label>Semester</label>
          <select
            value={semester}
            disabled={!branch}
            onChange={(e) => {
              setSemester(e.target.value);
              setSubjectCode('');
              setLoadedRoster(null);
            }}
          >
            <option value="">Select...</option>
            {semesters.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div style={{ flex: 2 }}>
          <label>Subject</label>
          <select
            value={subjectCode}
            disabled={!semester}
            onChange={(e) => {
              setSubjectCode(e.target.value);
              setLoadedRoster(null);
            }}
          >
            <option value="">Select...</option>
            {subjects.map((s) => (
              <option key={s.code} value={s.code}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div style={{ flex: 1 }}>
          <label>Date</label>
          <input
            type="date"
            value={date}
            onChange={(e) => {
              setDate(e.target.value);
              setLoadedRoster(null);
            }}
          />
        </div>
      </div>

      <button onClick={handleLoad} disabled={loadingClass} style={{ width: '100%', marginTop: '1rem' }}>
        {loadingClass ? 'Loading...' : 'Load Class'}
      </button>

      {status && <p style={{ marginTop: '1rem', fontSize: '0.9rem' }}>{status}</p>}

      {loadedRoster && (
        <>
          <div style={{ marginTop: '1.5rem', padding: '1rem', border: '1px solid var(--line)', borderRadius: 6 }}>
            <label style={{ fontWeight: 600 }}>Type absentee roll numbers (fastest)</label>
            <p style={{ fontSize: '0.8rem', color: 'var(--ink-soft)', margin: '0.25rem 0 0.5rem' }}>
              Comma or space separated. Full numbers (UG25CSE114) or just the last digits (114) both
              work. Everyone you don't list stays Present.
            </p>
            <textarea
              value={rollInput}
              onChange={(e) => setRollInput(e.target.value)}
              placeholder="e.g. 114, 117, 132"
              rows={2}
              style={{ width: '100%', fontFamily: 'inherit', fontSize: '0.9rem', padding: '0.5rem' }}
            />
            <button onClick={applyRollNumbers} style={{ width: '100%', marginTop: '0.5rem' }}>
              Apply to List
            </button>
            {rollInputFeedback && (
              <p style={{ fontSize: '0.8rem', marginTop: '0.5rem', marginBottom: 0 }}>{rollInputFeedback}</p>
            )}
          </div>

          <div style={{ maxHeight: 400, overflowY: 'auto', marginTop: '1rem', border: '1px solid var(--line)', borderRadius: 4 }}>
            {loadedRoster.map((student) => {
              const isAbsent = absentSet.has(student.regNo);
              return (
                <div
                  key={student.regNo}
                  onClick={() => toggleAbsent(student.regNo)}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '0.6rem 0.9rem',
                    borderBottom: '1px solid var(--line)',
                    cursor: 'pointer',
                    background: isAbsent ? 'rgba(220, 38, 38, 0.08)' : undefined,
                  }}
                >
                  <div>
                    <div style={{ fontSize: '0.9rem', fontWeight: 600 }}>{student.name}</div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--ink-soft)' }}>{student.regNo}</div>
                  </div>
                  <span
                    style={{
                      fontSize: '0.75rem',
                      fontWeight: 700,
                      color: '#fff',
                      background: isAbsent ? '#dc2626' : '#16a34a',
                      padding: '0.25rem 0.6rem',
                      borderRadius: 999,
                    }}
                  >
                    {isAbsent ? 'Absent' : 'Present'}
                  </span>
                </div>
              );
            })}
          </div>

          <button onClick={handleSave} disabled={saving} style={{ width: '100%', marginTop: '1rem' }}>
            {saving ? 'Saving...' : `Save — ${loadedRoster.length - absentSet.size} Present, ${absentSet.size} Absent`}
          </button>
        </>
      )}
    </div>
  );
}

export default MarkAttendance;
