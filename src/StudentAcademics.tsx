import { useEffect, useMemo, useState } from 'react';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { db } from './firebaseConfig';
import { evaluateStudent, GRADE_LABELS, isPassGrade } from './examRules';
import type { GradeDoc } from './examData';

const STANDING: Record<string, { label: string; color: string }> = {
  'no-results': { label: 'No results yet', color: 'var(--ink-soft)' },
  clear: { label: 'All clear', color: '#15803D' },
  backlogs: { label: 'Has backlogs', color: '#9A4A0F' },
  'at-risk': { label: 'At risk', color: '#B42318' },
};

type Registration = { id: string; eventTitle: string; status: string; subjects: { code: string }[] };

export default function StudentAcademics({ regNo, admissionYear }: { regNo: string; admissionYear: number }) {
  const [grades, setGrades] = useState<GradeDoc[] | null>(null);
  const [regs, setRegs] = useState<Registration[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    setGrades(null);
    setError('');
    getDocs(query(collection(db, 'grades'), where('studentEnrollmentNumber', '==', regNo)))
      .then((snap) => alive && setGrades(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<GradeDoc, 'id'>) }))))
      .catch((e) => alive && setError(`Couldn't load grades: ${e.message}`));
    getDocs(query(collection(db, 'examRegistrations'), where('enrollmentNumber', '==', regNo)))
      .then((snap) => alive && setRegs(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Registration, 'id'>) }))))
      .catch(() => alive && setRegs([]));
    return () => {
      alive = false;
    };
  }, [regNo]);

  const status = useMemo(() => (grades ? evaluateStudent(grades, admissionYear) : null), [grades, admissionYear]);

  const bySem = useMemo(() => {
    const m = new Map<number, GradeDoc[]>();
    (grades ?? []).forEach((g) => {
      const list = m.get(g.subjectSemester) ?? [];
      list.push(g);
      m.set(g.subjectSemester, list);
    });
    return Array.from(m.entries()).sort((a, b) => a[0] - b[0]);
  }, [grades]);

  if (error) return <p className="error-text">{error}</p>;
  if (!status) return <p className="res-hint">Loading academic record…</p>;

  const standing = STANDING[status.standing];
  const stat = (label: string, value: string | number, color?: string) => (
    <div style={{ flex: '1 1 90px', background: 'var(--panel-bg)', borderRadius: 12, padding: '0.6rem 0.7rem' }}>
      <div style={{ fontSize: '1.25rem', fontWeight: 800, color }}>{value}</div>
      <div style={{ fontSize: '0.75rem', color: 'var(--ink-soft)' }}>{label}</div>
    </div>
  );

  return (
    <div>
      <div style={{ fontWeight: 700, color: standing.color, marginBottom: '0.5rem' }}>
        {standing.label}
        {status.yearBack ? ' · year back risk' : ''}
      </div>
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        {stat('CGPA', status.cgpa?.toFixed(2) ?? '—')}
        {stat('Earned credits', status.earnedCredits)}
        {stat('Backlogs', status.counts.total, status.counts.total ? '#B42318' : undefined)}
        {stat('Supplementary', status.counts.supplementary)}
        {stat('Repeat', status.counts.repeat)}
        {stat('Incomplete', status.counts.pending)}
      </div>

      {status.creditTarget && (
        <p className="res-hint">
          Year {status.creditTarget.year} minimum: {status.creditTarget.earned} / {status.creditTarget.needed} earned credits
          {status.creditTarget.checked ? '' : ' (earlier semesters not fully recorded)'}
        </p>
      )}

      {status.alerts.map((a, i) => (
        <div key={i} style={{ marginTop: '0.6rem', fontSize: '0.85rem' }}>
          <strong style={{ color: a.level === 'high' ? '#B42318' : a.level === 'medium' ? '#9A4A0F' : undefined }}>{a.title}</strong>
          <span style={{ color: 'var(--ink-soft)' }}> · {a.rule}</span>
          <div>{a.detail}</div>
        </div>
      ))}

      {bySem.length > 0 && (
        <div style={{ marginTop: '1rem' }}>
          {bySem.map(([sem, list]) => {
            const summary = status.semesters.find((s) => s.semester === sem);
            return (
              <div key={sem} style={{ marginBottom: '0.8rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, fontSize: '0.9rem' }}>
                  <span>Semester {sem}</span>
                  <span>SGPA {summary?.sgpa?.toFixed(2) ?? '—'}</span>
                </div>
                {list
                  .sort((a, b) => a.subjectCode.localeCompare(b.subjectCode))
                  .map((g) => (
                    <div key={g.id} style={{ display: 'flex', justifyContent: 'space-between', gap: '0.6rem', fontSize: '0.84rem', padding: '0.25rem 0', borderBottom: '1px solid var(--line)' }}>
                      <span>
                        <strong>{g.subjectCode}</strong> {g.subjectName}
                        {g.history && g.history.length > 0 && (
                          <span style={{ color: 'var(--ink-soft)' }}> · earlier {g.history.map((h) => h.grade).join(', ')}</span>
                        )}
                      </span>
                      <span title={GRADE_LABELS[g.grade] ?? g.grade} style={{ fontWeight: 700, color: isPassGrade(g.grade) ? undefined : '#B42318', whiteSpace: 'nowrap' }}>
                        {g.grade} · {g.credits} cr
                      </span>
                    </div>
                  ))}
              </div>
            );
          })}
        </div>
      )}

      {regs && regs.length > 0 && (
        <div style={{ marginTop: '0.6rem' }}>
          <div className="eyebrow" style={{ fontSize: '0.65rem' }}>Exam registrations</div>
          {regs.map((r) => (
            <div key={r.id} style={{ fontSize: '0.84rem' }}>
              {r.eventTitle} · {r.subjects.map((s) => s.code).join(', ')} · {r.status}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
