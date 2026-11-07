import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { db } from './firebaseConfig';
import { COMPONENTS } from './marksImport';
import type { TableMark } from './MarksTable';
import './MarksBook.css';

type Student = { regNo: string; name: string };
type Comp = { score: number | null; absent: boolean; max: number };

const GRADE_CHOICES = ['AA', 'AB', 'BB', 'BC', 'CC', 'CD', 'DD', 'FF'];
const orderOf = (id: string) => {
  const i = COMPONENTS.findIndex((c) => c.id === id);
  return i === -1 ? 99 : i;
};
const labelOf = (id: string) => COMPONENTS.find((c) => c.id === id)?.label ?? id;
const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, ''));

export default function PublishedMarks({
  students,
  subjectCode,
  onMarks,
  gradeFor,
  overrides,
  onOverride,
  aboveTable,
}: {
  students: Student[];
  subjectCode: string;
  onMarks: (marks: TableMark[] | null, absent: string[]) => void;
  gradeFor: (total: number | null) => string | null;
  overrides: Record<string, string>;
  onOverride: (regNo: string, grade: string | null) => void;
  aboveTable?: ReactNode;
}) {
  const [data, setData] = useState<Map<string, Record<string, Comp>> | null>(null);
  const [err, setErr] = useState('');
  const [skip, setSkip] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let alive = true;
    setData(null);
    setErr('');
    getDocs(query(collection(db, 'marks'), where('subjectCode', '==', subjectCode)))
      .then((snap) => {
        if (!alive) return;
        const m = new Map<string, Record<string, Comp>>();
        snap.docs.forEach((d) => {
          const x = d.data() as { enrollmentNumber?: string; components?: Record<string, { score?: number | null; absent?: boolean; max?: number }> };
          if (!x.enrollmentNumber) return;
          const rec: Record<string, Comp> = {};
          for (const [id, c] of Object.entries(x.components ?? {})) {
            if (!c) continue;
            rec[id] = { score: typeof c.score === 'number' ? c.score : null, absent: c.absent === true, max: Number(c.max) || 0 };
          }
          m.set(x.enrollmentNumber, rec);
        });
        setData(m);
      })
      .catch((e) => alive && setErr(`Couldn't load published marks: ${e.message}`));
    return () => {
      alive = false;
    };
  }, [subjectCode]);

  const rows = useMemo(() => [...students].sort((a, b) => a.regNo.localeCompare(b.regNo)), [students]);

  const cols = useMemo(() => {
    if (!data) return [];
    const max = new Map<string, Map<number, number>>();
    for (const s of rows) {
      for (const [id, c] of Object.entries(data.get(s.regNo) ?? {})) {
        const v = max.get(id) ?? new Map<number, number>();
        v.set(c.max, (v.get(c.max) ?? 0) + 1);
        max.set(id, v);
      }
    }
    return Array.from(max.entries())
      .map(([id, v]) => ({ id, label: labelOf(id), max: Array.from(v.entries()).sort((a, b) => b[1] - a[1])[0][0] }))
      .sort((a, b) => orderOf(a.id) - orderOf(b.id));
  }, [data, rows]);

  const used = useMemo(() => cols.filter((c) => !skip[c.id]), [cols, skip]);
  const outOf = used.reduce((n, c) => n + c.max, 0);

  const computed = useMemo(() => {
    if (!data) return [];
    return rows.map((s) => {
      const rec = data.get(s.regNo) ?? {};
      let total = 0;
      let any = false;
      let missing = 0;
      for (const c of used) {
        const v = rec[c.id];
        if (!v) {
          missing++;
          continue;
        }
        any = true;
        if (!v.absent && v.score !== null) total += v.score;
      }
      return { ...s, rec, total: any ? Math.round(total * 100) / 100 : null, missing };
    });
  }, [data, rows, used]);

  useEffect(() => {
    if (!data) {
      onMarks(null, []);
      return;
    }
    onMarks(computed.map((r) => ({ regNo: r.regNo, name: r.name, total: r.total })), []);
  }, [computed, data]);

  const none = computed.filter((r) => r.total === null);
  const partial = computed.filter((r) => r.total !== null && r.missing > 0);

  if (err) return <p className="mb-note err" style={{ marginTop: '1rem' }}>{err}</p>;
  if (!data) return <p className="mb-hint" style={{ marginTop: '1rem' }}>Loading published marks…</p>;

  return (
    <div style={{ marginTop: '1.2rem', display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
      {aboveTable}
      {!cols.length ? (
        <p className="mb-note warn">
          No marks are published for {subjectCode} yet. Enter them on Marks &amp; grades → 1 · Marks (quizzes, mid sem, end sem, attendance), then come back here.
        </p>
      ) : (
        <>
          <div className="mb-bar">
            <span className="mb-hint">Total out of {outOf}, from the marks already published. Untick an exam to leave it out of the total:</span>
            {cols.map((c) => (
              <label key={c.id} className="mb-check">
                <input type="checkbox" checked={!skip[c.id]} onChange={(e) => setSkip((m) => ({ ...m, [c.id]: !e.target.checked }))} /> {c.label} ({c.max})
              </label>
            ))}
          </div>
          <div className="mb-grid-wrap">
            <table className="mb-grid">
              <thead>
                <tr>
                  <th className="mb-sticky">Enrollment</th>
                  <th className="mb-sticky2">Name</th>
                  {used.map((c) => (
                    <th key={c.id}>
                      <div className="mb-colhead"><span className="t">{c.label}</span><span className="mb-sub">/ {c.max}</span></div>
                    </th>
                  ))}
                  <th>Total / {outOf}</th>
                  <th>Grade</th>
                </tr>
              </thead>
              <tbody>
                {computed.map((r) => {
                  const auto = gradeFor(r.total);
                  const over = overrides[r.regNo];
                  return (
                    <tr key={r.regNo}>
                      <td className="mb-sticky mb-reg">{r.regNo}</td>
                      <td className="mb-sticky2 mb-name" title={r.name}>{r.name}</td>
                      {used.map((c) => {
                        const v = r.rec[c.id];
                        return (
                          <td key={c.id} className="mb-num">
                            {!v ? <span className="mb-sub">—</span> : v.absent ? 'AB' : v.score === null ? '—' : fmt(v.score)}
                          </td>
                        );
                      })}
                      <td className="mb-num mb-total">{r.total === null ? '—' : fmt(r.total)}</td>
                      <td className="mb-cell">
                        <select
                          value={over ?? ''}
                          className="mb-in"
                          style={{ width: 96, ...(over ? { borderColor: '#D97706', fontWeight: 700 } : {}) }}
                          title={over ? `Changed by you (marks say ${auto ?? '—'})` : 'Follows the cutoffs; pick a grade to change it'}
                          onChange={(e) => onOverride(r.regNo, e.target.value || null)}
                        >
                          <option value="">{auto ?? '—'}</option>
                          {GRADE_CHOICES.map((g) => <option key={g} value={g}>{g}{g === auto ? ' (auto)' : ''}</option>)}
                        </select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {none.length > 0 && (
            <p className="mb-note warn">
              {none.length} student{none.length === 1 ? ' has' : 's have'} no published marks and will get FF unless you change it: {none.slice(0, 8).map((r) => r.name).join(', ')}
              {none.length > 8 ? `, +${none.length - 8} more` : ''}.
            </p>
          )}
          {partial.length > 0 && (
            <p className="mb-hint">
              {partial.length} student{partial.length === 1 ? ' is' : 's are'} missing some exams (shown as —); those count as 0. Fix them on the Marks page if that's wrong.
            </p>
          )}
        </>
      )}
    </div>
  );
}
