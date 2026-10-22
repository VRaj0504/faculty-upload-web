import { useState } from 'react';
import type { ExamEntry } from './examSheetParser';

const cellInput: React.CSSProperties = { width: '100%', boxSizing: 'border-box', padding: '0.35rem 0.4rem', fontSize: '0.85rem' };

const blankEntry = (): ExamEntry => ({
  date: '',
  startTime: '',
  endTime: '',
  subjectCode: '',
  subjectName: '',
  venue: '',
});

function ExamEntriesTable({
  entries,
  onChange,
  problemRows = [],
  onRowEdited,
  subjects,
}: {
  entries: ExamEntry[];
  onChange: (next: ExamEntry[]) => void;

  subjects?: { code: string; name: string }[];
  problemRows?: number[];
  onRowEdited?: (rowNumber: number) => void;
}) {
  const [customRows, setCustomRows] = useState<Set<number>>(new Set());
  const update = (i: number, patch: Partial<ExamEntry>) => {
    onChange(entries.map((e, idx) => (idx === i ? { ...e, ...patch } : e)));
    onRowEdited?.(i + 1);
  };

  return (
    <>
      <div style={{ overflowX: 'auto', marginTop: '0.75rem' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
          <thead>
            <tr style={{ textAlign: 'left', fontSize: '0.75rem' }}>
              <th style={{ width: 140 }}>Date</th>
              <th style={{ width: 100 }}>Start</th>
              <th style={{ width: 100 }}>End</th>
              <th style={{ width: 130 }}>Code</th>
              <th>Subject</th>
              <th style={{ width: 130 }}>Venue</th>
              <th style={{ width: 36 }} />
            </tr>
          </thead>
          <tbody>
            {entries.map((e, i) => (
              <tr key={i} style={problemRows.includes(i + 1) ? { background: '#fef3c7' } : undefined}>
                <td><input type="date" style={cellInput} value={e.date} onChange={(ev) => update(i, { date: ev.target.value })} /></td>
                <td><input type="time" style={cellInput} value={e.startTime} onChange={(ev) => update(i, { startTime: ev.target.value })} /></td>
                <td><input type="time" style={cellInput} value={e.endTime} onChange={(ev) => update(i, { endTime: ev.target.value })} /></td>
                <td>
                  {subjects && subjects.length > 0 ? (
                    <>
                      <select
                        style={cellInput}
                        value={customRows.has(i) || (e.subjectCode && !subjects.some((o) => o.code === e.subjectCode.trim())) ? '__other__' : e.subjectCode.trim()}
                        onChange={(ev) => {
                          if (ev.target.value === '__other__') {
                            setCustomRows((prev) => new Set(prev).add(i));
                            return;
                          }
                          setCustomRows((prev) => {
                            const next = new Set(prev);
                            next.delete(i);
                            return next;
                          });
                          const chosen = subjects.find((o) => o.code === ev.target.value);
                          update(i, chosen ? { subjectCode: chosen.code, subjectName: chosen.name } : { subjectCode: '', subjectName: '' });
                        }}
                      >
                        <option value="">Pick…</option>
                        {subjects.map((o) => <option key={o.code} value={o.code}>{o.code}</option>)}
                        <option value="__other__">Other…</option>
                      </select>
                      {(customRows.has(i) || (e.subjectCode && !subjects.some((o) => o.code === e.subjectCode.trim()))) && (
                        <input
                          style={{ ...cellInput, marginTop: 4 }}
                          placeholder="Code"
                          value={e.subjectCode}
                          onChange={(ev) => update(i, { subjectCode: ev.target.value })}
                        />
                      )}
                    </>
                  ) : (
                    <input style={cellInput} value={e.subjectCode} onChange={(ev) => update(i, { subjectCode: ev.target.value })} />
                  )}
                </td>
                <td><input style={cellInput} value={e.subjectName} onChange={(ev) => update(i, { subjectName: ev.target.value })} /></td>
                <td><input style={cellInput} value={e.venue} onChange={(ev) => update(i, { venue: ev.target.value })} /></td>
                <td>
                  <button
                    type="button"
                    aria-label={`Remove row ${i + 1}`}
                    onClick={() => onChange(entries.filter((_, idx) => idx !== i))}
                    style={{ padding: '0.2rem 0.5rem' }}
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button type="button" onClick={() => onChange([...entries, blankEntry()])} style={{ marginTop: '0.6rem' }}>
        + Add exam
      </button>
    </>
  );
}

export default ExamEntriesTable;
