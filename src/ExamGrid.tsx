import { useMemo, useState } from 'react';
import { branchesOf, type ExamEntry } from './examSheetParser';
import { curriculum } from './curriculum';
import ExamEntriesTable from './ExamEntriesTable';

// The date sheet as a grid, the same way the Timetable editor shows a
// week: exam DATES down the side, exam SESSIONS (time slots) across the
// top, and each cell is "which subject sits this session". Picking a
// subject from the curriculum fills its code and name, so nothing is
// typed twice or spelled wrong.
//
// It's only a different view of the same `entries` list the row editor
// uses — nothing new is stored. Dates/sessions with no exam yet are kept
// in local state so faculty can lay the grid out first and fill it after.

type Session = { start: string; end: string };
const sessionKey = (s: Session) => `${s.start}|${s.end}`;
const isPlaced = (e: ExamEntry) => /^\d{4}-\d{2}-\d{2}$/.test(e.date) && /^\d{2}:\d{2}$/.test(e.startTime);

const pad = (n: number) => String(n).padStart(2, '0');
const isoOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dateOf = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const nextExamDay = (iso: string) => {
  const d = dateOf(iso);
  do d.setDate(d.getDate() + 1);
  while (d.getDay() === 0); // skip Sundays
  return isoOf(d);
};

function fmt12(t: string) {
  const m = t.match(/^(\d{2}):(\d{2})$/);
  if (!m) return t || '—';
  const h = Number(m[1]);
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h >= 12 ? 'PM' : 'AM'}`;
}

function subjectOptions(branch: string, semester: string): { code: string; name: string }[] {
  const sem = Number(semester);
  const branches = branchesOf(branch);
  const seen = new Map<string, string>();
  for (const b of branches) {
    const list = curriculum[b as keyof typeof curriculum]?.[sem] ?? [];
    for (const s of list) if (!seen.has(s.code)) seen.set(s.code, s.name);
  }
  return Array.from(seen, ([code, name]) => ({ code, name }));
}
const norm = (code: string) => code.replace(/\s+/g, '').toUpperCase();

function defaultSession(examType: string): Session {
  // Mid-sems/quizzes at IIIT Surat are short morning papers; end-sems are
  // three hours. Only a starting point — every column's time is editable.
  return /endsem|supplementary/.test(examType) ? { start: '10:00', end: '13:00' } : { start: '09:00', end: '10:30' };
}

export default function ExamGrid({
  entries,
  onChange,
  branch,
  semester,
  examType = '',
}: {
  entries: ExamEntry[];
  onChange: (next: ExamEntry[]) => void;
  branch: string;
  semester: string;
  examType?: string;
}) {
  const [extraDates, setExtraDates] = useState<string[]>([]);
  const [extraSessions, setExtraSessions] = useState<Session[]>([]);
  const [rangeFrom, setRangeFrom] = useState('');
  const [rangeTo, setRangeTo] = useState('');

  const options = useMemo(() => subjectOptions(branch, semester), [branch, semester]);

  const placed = entries.filter(isPlaced);
  const unplaced = entries.filter((e) => !isPlaced(e));

  const dates = useMemo(
    () => Array.from(new Set([...extraDates, ...placed.map((e) => e.date)])).sort(),
    [extraDates, entries],
  );
  const sessions = useMemo(() => {
    const map = new Map<string, Session>();
    for (const s of extraSessions) map.set(sessionKey(s), s);
    for (const e of placed) map.set(sessionKey({ start: e.startTime, end: e.endTime }), { start: e.startTime, end: e.endTime });
    return Array.from(map.values()).sort((a, b) => (a.start + a.end).localeCompare(b.start + b.end));
  }, [extraSessions, entries]);

  // Same subject booked twice is almost always a mistake — flag it.
  const repeatedCodes = useMemo(() => {
    const count = new Map<string, number>();
    for (const e of placed) {
      const k = norm(e.subjectCode || e.subjectName);
      if (k) count.set(k, (count.get(k) ?? 0) + 1);
    }
    return new Set(Array.from(count).filter(([, n]) => n > 1).map(([k]) => k));
  }, [entries]);

  const inCell = (date: string, s: Session) =>
    entries
      .map((e, index) => ({ e, index }))
      .filter(({ e }) => isPlaced(e) && e.date === date && e.startTime === s.start && e.endTime === s.end);

  const patch = (index: number, changes: Partial<ExamEntry>) =>
    onChange(entries.map((e, i) => (i === index ? { ...e, ...changes } : e)));

  const addExam = (date: string, s: Session) =>
    onChange([...entries, { date, startTime: s.start, endTime: s.end, subjectCode: '', subjectName: '', venue: '' }]);

  // ---- rows (dates) ----
  const addDate = () => {
    const last = dates[dates.length - 1];
    const next = last ? nextExamDay(last) : isoOf(new Date());
    setExtraDates((d) => [...d, next]);
    if (sessions.length === 0) setExtraSessions([defaultSession(examType)]);
  };
  const addRange = () => {
    if (!rangeFrom || !rangeTo || rangeTo < rangeFrom) return;
    const out: string[] = [];
    for (let d = dateOf(rangeFrom); isoOf(d) <= rangeTo && out.length < 40; d.setDate(d.getDate() + 1)) {
      if (d.getDay() !== 0) out.push(isoOf(d));
    }
    setExtraDates((prev) => Array.from(new Set([...prev, ...out])));
    if (sessions.length === 0) setExtraSessions([defaultSession(examType)]);
    setRangeFrom('');
    setRangeTo('');
  };
  const changeDate = (from: string, to: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(to) || from === to) return;
    setExtraDates((d) => d.map((x) => (x === from ? to : x)));
    onChange(entries.map((e) => (e.date === from ? { ...e, date: to } : e)));
  };
  const removeDate = (date: string) => {
    const n = placed.filter((e) => e.date === date).length;
    if (n && !confirm(`Remove ${dateOf(date).toDateString()} and its ${n} exam${n === 1 ? '' : 's'}?`)) return;
    setExtraDates((d) => d.filter((x) => x !== date));
    if (n) onChange(entries.filter((e) => !(isPlaced(e) && e.date === date)));
  };

  // ---- columns (sessions) ----
  const addSession = () => {
    const last = sessions[sessions.length - 1];
    let next = defaultSession(examType);
    if (last) {
      // Next session starts an hour after the last one ends.
      const [h, m] = (last.end || last.start).split(':').map(Number);
      const len = last.end ? toMin(last.end) - toMin(last.start) : 90;
      const start = Math.min(h * 60 + m + 60, 20 * 60);
      next = { start: fromMin(start), end: fromMin(Math.min(start + Math.max(len, 60), 22 * 60)) };
    }
    setExtraSessions((s) => [...s, next]);
  };
  const changeSession = (from: Session, to: Session) => {
    if (!/^\d{2}:\d{2}$/.test(to.start)) return;
    if (to.end && to.end <= to.start) return;
    setExtraSessions((s) => s.map((x) => (sessionKey(x) === sessionKey(from) ? to : x)));
    onChange(
      entries.map((e) =>
        isPlaced(e) && e.startTime === from.start && e.endTime === from.end ? { ...e, startTime: to.start, endTime: to.end } : e,
      ),
    );
  };
  const removeSession = (s: Session) => {
    const n = placed.filter((e) => e.startTime === s.start && e.endTime === s.end).length;
    if (n && !confirm(`Remove the ${fmt12(s.start)} session and its ${n} exam${n === 1 ? '' : 's'}?`)) return;
    setExtraSessions((x) => x.filter((y) => sessionKey(y) !== sessionKey(s)));
    if (n) onChange(entries.filter((e) => !(isPlaced(e) && e.startTime === s.start && e.endTime === s.end)));
  };

  const empty = dates.length === 0;

  return (
    <div className="exam-grid-wrap">
      {empty ? (
        <div className="exam-grid-empty">
          <strong>Lay out the exam days first</strong>
          <p>Add the date range of the exams, then pick a subject in each session.</p>
        </div>
      ) : (
        <div className="exam-grid-scroll">
          <table className="exam-grid">
            <thead>
              <tr>
                <th className="exam-grid-corner">Date</th>
                {sessions.map((s) => (
                  <th key={sessionKey(s)} className="exam-grid-session">
                    <div className="exam-grid-session-times">
                      <input
                        type="time"
                        aria-label="Session start"
                        value={s.start}
                        onChange={(e) => changeSession(s, { ...s, start: e.target.value })}
                      />
                      <span>–</span>
                      <input
                        type="time"
                        aria-label="Session end"
                        value={s.end}
                        onChange={(e) => changeSession(s, { ...s, end: e.target.value })}
                      />
                      <button type="button" className="exam-grid-x" aria-label="Remove session" onClick={() => removeSession(s)}>
                        ×
                      </button>
                    </div>
                  </th>
                ))}
                <th className="exam-grid-add-col">
                  <button type="button" className="button-secondary" onClick={addSession}>
                    + Session
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {dates.map((date) => {
                const d = dateOf(date);
                const sunday = d.getDay() === 0;
                return (
                  <tr key={date}>
                    <th className="exam-grid-date">
                      <div className="exam-grid-day">
                        <span className={sunday ? 'exam-grid-sunday' : undefined}>
                          {d.toLocaleDateString('en-IN', { weekday: 'short' })}
                        </span>
                        <button type="button" className="exam-grid-x" aria-label="Remove date" onClick={() => removeDate(date)}>
                          ×
                        </button>
                      </div>
                      <input type="date" aria-label="Exam date" value={date} onChange={(e) => changeDate(date, e.target.value)} />
                    </th>
                    {sessions.map((s) => {
                      const here = inCell(date, s);
                      return (
                        <td key={sessionKey(s)} className={here.length ? 'exam-grid-cell has-exam' : 'exam-grid-cell'}>
                          {here.map(({ e, index }) => {
                            const matched = options.find((o) => norm(o.code) === norm(e.subjectCode));
                            const custom = options.length === 0 || (!matched && !!(e.subjectCode || e.subjectName));
                            const repeated = repeatedCodes.has(norm(e.subjectCode || e.subjectName));
                            return (
                              <div key={index} className={`exam-chip${repeated ? ' exam-chip-warn' : ''}`}>
                                <div className="exam-chip-row">
                                  {options.length > 0 ? (
                                    <select
                                      aria-label="Subject"
                                      value={matched ? matched.code : e.subjectCode || e.subjectName ? '__custom__' : ''}
                                      onChange={(ev) => {
                                        const v = ev.target.value;
                                        if (v === '__custom__') return patch(index, { subjectCode: e.subjectCode || ' ', subjectName: e.subjectName });
                                        const o = options.find((x) => x.code === v);
                                        if (o) patch(index, { subjectCode: o.code, subjectName: o.name });
                                      }}
                                    >
                                      <option value="" disabled>
                                        Pick subject…
                                      </option>
                                      {options.map((o) => (
                                        <option key={o.code} value={o.code}>
                                          {o.code} · {o.name}
                                        </option>
                                      ))}
                                      <option value="__custom__">Other / elective…</option>
                                    </select>
                                  ) : null}
                                  <button
                                    type="button"
                                    className="exam-grid-x"
                                    aria-label="Remove exam"
                                    onClick={() => onChange(entries.filter((_, i) => i !== index))}
                                  >
                                    ×
                                  </button>
                                </div>
                                {custom && (
                                  <div className="exam-chip-custom">
                                    <input
                                      placeholder="Code"
                                      value={e.subjectCode.trim()}
                                      onChange={(ev) => patch(index, { subjectCode: ev.target.value })}
                                    />
                                    <input
                                      placeholder="Subject name"
                                      value={e.subjectName}
                                      onChange={(ev) => patch(index, { subjectName: ev.target.value })}
                                    />
                                  </div>
                                )}
                                <input
                                  className="exam-chip-venue"
                                  placeholder="Venue (optional)"
                                  value={e.venue}
                                  onChange={(ev) => patch(index, { venue: ev.target.value })}
                                />
                                {repeated && <span className="exam-chip-note">Also on another day</span>}
                              </div>
                            );
                          })}
                          <button
                            type="button"
                            className="exam-grid-add"
                            onClick={() => addExam(date, s)}
                            title={here.length ? 'Another paper in the same session (electives)' : 'Add an exam here'}
                          >
                            {here.length ? '+ Elective' : '+ Exam'}
                          </button>
                          {here.length > 1 && <span className="exam-chip-note">{here.length} papers at once — fine for electives</span>}
                        </td>
                      );
                    })}
                    <td className="exam-grid-add-col" />
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="exam-grid-toolbar">
        <button type="button" className="button-secondary" onClick={addDate}>
          + Next day
        </button>
        <span className="exam-grid-or">or add a range</span>
        <input type="date" aria-label="From" value={rangeFrom} onChange={(e) => setRangeFrom(e.target.value)} />
        <span>to</span>
        <input type="date" aria-label="To" value={rangeTo} onChange={(e) => setRangeTo(e.target.value)} />
        <button type="button" disabled={!rangeFrom || !rangeTo || rangeTo < rangeFrom} onClick={addRange}>
          Add days
        </button>
        <span className="exam-grid-hint">Sundays are skipped. {placed.length} exam{placed.length === 1 ? '' : 's'} on the grid.</span>
      </div>

      {unplaced.length > 0 && (
        <div className="exam-grid-unplaced">
          <strong>{unplaced.length} exam{unplaced.length === 1 ? '' : 's'} missing a date or start time</strong>
          <p>Fix them here and they move onto the grid.</p>
          <ExamEntriesTable entries={unplaced} onChange={(next) => onChange([...placed, ...next])} subjects={options} />
        </div>
      )}
    </div>
  );
}

function toMin(t: string) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}
function fromMin(n: number) {
  return `${pad(Math.floor(n / 60))}:${pad(n % 60)}`;
}
