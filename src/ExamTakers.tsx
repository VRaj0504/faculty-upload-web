import { useMemo, useState } from 'react';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { db } from './firebaseConfig';
import { REG } from './marksImport';
import type { ExamEntry } from './examSheetParser';

export type Takers = Record<string, string[]>;

export const needsTakers = (examType: string) => examType.endsWith('-repeaters') || examType === 'supplementary';

export function cleanTakers(t: Takers): { takers: Takers; students: string[] } {
  const takers: Takers = {};
  const all = new Set<string>();
  for (const [code, list] of Object.entries(t)) {
    const uniq = Array.from(new Set(list.map((r) => r.trim().toUpperCase()).filter((r) => REG.test(r))));
    if (!uniq.length) continue;
    takers[code.trim().toUpperCase()] = uniq;
    uniq.forEach((r) => all.add(r));
  }
  return { takers, students: Array.from(all).sort() };
}

const split = (s: string) => s.toUpperCase().split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);

export default function ExamTakers({
  examType,
  entries,
  value,
  onChange,
}: {
  examType: string;
  entries: ExamEntry[];
  value: Takers;
  onChange: (next: Takers) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');

  const subjects = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of entries) {
      const code = e.subjectCode.trim().toUpperCase();
      if (code && !m.has(code)) m.set(code, e.subjectName.trim());
    }
    return Array.from(m, ([code, name]) => ({ code, name }));
  }, [entries]);

  if (!needsTakers(examType) || !subjects.length) return null;

  const textOf = (code: string) => drafts[code] ?? (value[code] ?? []).join(', ');
  const setText = (code: string, text: string) => {
    setDrafts((d) => ({ ...d, [code]: text }));
    onChange({ ...value, [code]: split(text) });
  };

  const fromAbsentees = async (code: string) => {
    setBusy(code);
    setNote('');
    try {
      const snap = await getDocs(query(collection(db, 'marks'), where('subjectCode', '==', code)));
      const regs = snap.docs
        .map((d) => d.data() as { enrollmentNumber?: string; components?: Record<string, { absent?: boolean }> })
        .filter((x) => x.enrollmentNumber && x.components?.['mid-sem']?.absent === true)
        .map((x) => String(x.enrollmentNumber).toUpperCase());
      const merged = Array.from(new Set([...(value[code] ?? []), ...regs])).sort();
      setText(code, merged.join(', '));
      setNote(
        regs.length
          ? `${code}: added ${regs.length} student${regs.length === 1 ? '' : 's'} marked AB in the mid sem.`
          : `${code}: no one is marked AB in the published mid-sem marks. Add roll numbers by hand.`,
      );
    } catch (e: any) {
      setNote(`Couldn't read marks for ${code}: ${e.message}`);
    } finally {
      setBusy('');
    }
  };

  const total = new Set(Object.values(value).flat().filter((r) => REG.test(r))).size;
  const anyListed = total > 0;

  return (
    <div style={{ marginTop: '1rem', padding: '0.9rem 1rem', borderRadius: 8, background: 'var(--panel-bg, #f6f8fb)', border: '1px solid var(--line, #e3e7ee)' }}>
      <strong style={{ fontSize: '0.92rem' }}>Who takes these exams</strong>
      <p style={{ fontSize: '0.8rem', color: 'var(--ink-soft)', margin: '0.3rem 0 0.6rem' }}>
        {anyListed
          ? `Only the ${total} listed student${total === 1 ? '' : 's'} see this sheet and get the notification, each for their own subjects. They see it even if they are now in a later semester.`
          : 'Leave every box empty to show this sheet to the whole semester. Add roll numbers to show each subject only to the students taking it.'}
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
        {subjects.map((s) => {
          const list = (value[s.code] ?? []).filter(Boolean);
          const bad = list.filter((r) => !REG.test(r));
          const good = list.length - bad.length;
          return (
            <div key={s.code}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', marginBottom: 4 }}>
                <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>{s.code}</span>
                <span style={{ fontSize: '0.82rem', color: 'var(--ink-soft)' }}>{s.name}</span>
                <span style={{ fontSize: '0.78rem', marginLeft: 'auto' }}>{good ? `${good} student${good === 1 ? '' : 's'}` : 'Everyone in the semester'}</span>
                {examType === 'midsem-repeaters' && (
                  <button type="button" className="button-secondary" style={{ padding: '0.25rem 0.6rem', fontSize: '0.78rem' }} disabled={busy === s.code} onClick={() => fromAbsentees(s.code)}>
                    {busy === s.code ? 'Reading…' : 'Add mid-sem absentees'}
                  </button>
                )}
              </div>
              <textarea
                rows={2}
                value={textOf(s.code)}
                placeholder="Paste roll numbers, e.g. UG24CSE012, UG24CSE047"
                onChange={(e) => setText(s.code, e.target.value)}
                style={{ width: '100%', boxSizing: 'border-box', fontSize: '0.82rem' }}
              />
              {bad.length > 0 && (
                <p style={{ fontSize: '0.76rem', color: '#b45309', margin: '2px 0 0' }}>
                  Not a roll number, will be skipped: {bad.slice(0, 5).join(', ')}
                  {bad.length > 5 ? ` +${bad.length - 5} more` : ''}
                </p>
              )}
            </div>
          );
        })}
      </div>
      {note && <p style={{ fontSize: '0.8rem', margin: '0.6rem 0 0' }}>{note}</p>}
    </div>
  );
}
