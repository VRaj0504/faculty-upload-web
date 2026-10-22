import { useState, useEffect, type ReactElement } from 'react';
import { doc, getDoc, setDoc, serverTimestamp, collection, getDocs } from 'firebase/firestore';
import { ref, uploadBytes } from 'firebase/storage';
import { httpsCallable } from 'firebase/functions';
import { db, storage, functions, auth } from './firebaseConfig';
import { curriculum } from './curriculum';
import { FACULTY_LEGEND } from './facultyLegend';
import { cleanDays, loadRoomAliases } from './roomNames';
import {
  parseSpreadsheetFile,
  renderPdfFirstPageToJpegBlob,
  parseAnySpreadsheetAllSections,
  renderAllPdfPagesToJpegBlobs,
  detectSectionFromHeaderText,
  WHOLE_COLLEGE_TIMETABLE_TEMPLATE_CSV,
  type MultiSectionGroup,
} from './timetableImport';

type TimetableSlot = {
  id: string;
  startTime: string;
  endTime: string;
  subjectCode: string;
  subjectName: string;
  faculty: string;
  room: string;
  group?: string;
};

type TimetableDay = {
  day: string;
  slots: TimetableSlot[];
};

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

function timetableDocId(branch: string, semester: number, section: string): string {
  return `${branch}-${semester}-${section}`;
}

function emptySlot(): TimetableSlot {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    startTime: '',
    endTime: '',
    subjectCode: '',
    subjectName: '',
    faculty: '',
    room: '',
  };
}

function emptyWeek(): TimetableDay[] {
  return WEEKDAYS.map((day) => ({ day, slots: [] }));
}

function subjectOptionsFor(branchValue: string, semesterValue: string): { code: string; name: string }[] {
  const branchKey = branchValue.trim().toUpperCase() as keyof typeof curriculum;
  const semesterNum = Number(semesterValue);
  if (!curriculum[branchKey] || !semesterNum) return [];
  return curriculum[branchKey][semesterNum] ?? [];
}

function normalizeCode(code: string): string {
  return code.replace(/\s+/g, '').toUpperCase();
}

function matchCurriculumOption(
  options: { code: string; name: string }[],
  code: string,
): { code: string; name: string } | undefined {
  return options.find((o) => normalizeCode(o.code) === normalizeCode(code));
}

const FACULTY_DATALIST_OPTIONS = Object.entries(FACULTY_LEGEND).map(([initials, name]) => ({
  initials,
  name,
}));

function SlotRow({
  slot,
  branch,
  semester,
  onChange,
  onRemove,
}: {
  slot: TimetableSlot;
  branch: string;
  semester: string;
  onChange: (changes: Partial<TimetableSlot>) => void;
  onRemove: () => void;
}) {
  const subjectOptions = subjectOptionsFor(branch, semester);
  const matchedOption = matchCurriculumOption(subjectOptions, slot.subjectCode);
  const isKnownCode = subjectOptions.length === 0 || !!matchedOption;
  return (
    <div
      style={{
        display: 'flex',
        gap: '0.4rem',
        alignItems: 'center',
        marginBottom: '0.4rem',
        fontSize: '0.8rem',
        flexWrap: 'wrap',
      }}
    >
      <input
        type="text"
        value={slot.startTime}
        onChange={(e) => onChange({ startTime: e.target.value })}
        placeholder="9:00"
        style={{ width: 60 }}
      />
      <input
        type="text"
        value={slot.endTime}
        onChange={(e) => onChange({ endTime: e.target.value })}
        placeholder="10:00"
        style={{ width: 60 }}
      />
      {subjectOptions.length === 0 ? (

        <input
          type="text"
          value={slot.subjectCode}
          onChange={(e) => onChange({ subjectCode: e.target.value })}
          placeholder="CS301"
          style={{ width: 80 }}
          title="Set Branch and Semester to get a pick-list here"
        />
      ) : (
        <select
          value={matchedOption ? matchedOption.code : '__custom__'}
          onChange={(e) => {
            if (e.target.value === '__custom__') return;
            const chosen = subjectOptions.find((o) => o.code === e.target.value);

            onChange(chosen ? { subjectCode: e.target.value, subjectName: chosen.name } : { subjectCode: e.target.value });
          }}
          style={{ width: 190 }}
        >
          <option value="" disabled>
            Pick a subject...
          </option>
          {subjectOptions.map((o) => (
            <option key={o.code} value={o.code}>
              {o.code} — {o.name}
            </option>
          ))}
          <option value="__custom__">Other / elective (type below)</option>
        </select>
      )}
      {subjectOptions.length > 0 && !isKnownCode && (
        <>
          <input
            type="text"
            value={slot.subjectCode}
            onChange={(e) => onChange({ subjectCode: e.target.value })}
            placeholder="Code"
            style={{ width: 70 }}
          />
          <input
            type="text"
            value={slot.subjectName}
            onChange={(e) => onChange({ subjectName: e.target.value })}
            placeholder="Subject name"
            style={{ flex: 1, minWidth: 100 }}
          />
        </>
      )}
      <input
        type="text"
        list="faculty-legend-options"
        value={slot.faculty}
        onChange={(e) => onChange({ faculty: e.target.value })}
        placeholder="Faculty (start typing a name)"
        style={{ width: 140 }}
      />
      <input
        type="text"
        value={slot.room}
        onChange={(e) => onChange({ room: e.target.value })}
        placeholder="Room"
        style={{ width: 70 }}
      />
      <input
        type="text"
        value={slot.group ?? ''}
        onChange={(e) => onChange({ group: e.target.value })}
        placeholder="Group (opt.)"
        style={{ width: 90 }}
      />
      <button onClick={onRemove} className="button-secondary" style={{ padding: '0.2rem 0.5rem' }}>
        ✕
      </button>
    </div>
  );
}

function FacultyDatalist() {
  return (
    <datalist id="faculty-legend-options">
      {FACULTY_DATALIST_OPTIONS.map((f) => (
        <option key={f.initials} value={f.initials}>
          {f.name}
        </option>
      ))}
    </datalist>
  );
}

const GRID_TIME_COLUMNS: { label: string; header: string; startTime: string; endTime: string }[] = [
  { label: '1', header: '9-10 AM', startTime: '9:00', endTime: '10:00' },
  { label: '2', header: '10-11 AM', startTime: '10:00', endTime: '11:00' },
  { label: '3', header: '11-12', startTime: '11:00', endTime: '12:00' },
  { label: '4', header: '12-1 PM', startTime: '12:00', endTime: '13:00' },
  { label: '5', header: '1-2 PM', startTime: '13:00', endTime: '14:00' },
  { label: '6', header: '2-3 PM', startTime: '14:00', endTime: '15:00' },
  { label: '7', header: '3-4 PM', startTime: '15:00', endTime: '16:00' },
  { label: '8', header: '4-5 PM', startTime: '16:00', endTime: '17:00' },
  { label: '9', header: '5-6 PM', startTime: '17:00', endTime: '18:00' },
];
const GRID_DAY_LABELS: Record<string, string> = {
  Monday: 'Mo',
  Tuesday: 'Tu',
  Wednesday: 'We',
  Thursday: 'Th',
  Friday: 'Fr',
};

function timeToMinutes(raw: string): number | null {
  const match = raw.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
}

function GridCell({
  slots,
  branch,
  semester,
  column,
  colSpan,
  maxSpanHours,
  onUpdateSlot,
  onAddSlot,
  onRemoveSlot,
}: {
  slots: TimetableSlot[];
  branch: string;
  semester: string;
  column: (typeof GRID_TIME_COLUMNS)[number];
  colSpan: number;
  maxSpanHours: number;
  onUpdateSlot: (slotId: string, changes: Partial<TimetableSlot>) => void;
  onAddSlot: (group?: string, hours?: number) => void;
  onRemoveSlot: (slotId: string) => void;
}) {
  const subjectOptions = subjectOptionsFor(branch, semester);
  const startMinutes = timeToMinutes(column.startTime)!;

  const renderMiniEditor = (slot: TimetableSlot) => {
    const matchedOption = matchCurriculumOption(subjectOptions, slot.subjectCode);
    const isKnownCode = subjectOptions.length === 0 || !!matchedOption;
    const endMinutes = timeToMinutes(slot.endTime);

    const durationHours = endMinutes != null ? Math.max(1, Math.round((endMinutes - startMinutes) / 60)) : 1;
    return (
      <div key={slot.id} style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', marginBottom: '0.3rem' }}>
        {slots.length > 1 && (
          <input
            type="text"
            value={slot.group ?? ''}
            onChange={(e) => onUpdateSlot(slot.id, { group: e.target.value })}
            placeholder="Group 1 / Div. 1"
            style={{ fontSize: '0.65rem', padding: '0.1rem 0.3rem' }}
          />
        )}
        {subjectOptions.length === 0 ? (
          <input
            type="text"
            value={slot.subjectCode}
            onChange={(e) => onUpdateSlot(slot.id, { subjectCode: e.target.value })}
            placeholder="Code"
            style={{ fontSize: '0.7rem', padding: '0.15rem 0.3rem' }}
            title="Set Branch and Semester to get a pick-list here"
          />
        ) : (
          <select
            value={matchedOption ? matchedOption.code : '__custom__'}
            onChange={(e) => {
              if (e.target.value === '__custom__') return;
              const chosen = subjectOptions.find((o) => o.code === e.target.value);

              onUpdateSlot(
                slot.id,
                chosen ? { subjectCode: e.target.value, subjectName: chosen.name } : { subjectCode: e.target.value },
              );
            }}
            style={{ fontSize: '0.7rem', padding: '0.15rem 0.2rem', width: '100%' }}
          >
            <option value="" disabled>
              Pick…
            </option>
            {subjectOptions.map((o) => (
              <option key={o.code} value={o.code}>
                {o.code}
              </option>
            ))}
            <option value="__custom__">Other…</option>
          </select>
        )}
        {subjectOptions.length > 0 && !isKnownCode && (
          <input
            type="text"
            value={slot.subjectCode}
            onChange={(e) => onUpdateSlot(slot.id, { subjectCode: e.target.value })}
            placeholder="Code"
            style={{ fontSize: '0.7rem', padding: '0.15rem 0.3rem' }}
          />
        )}
        <input
          type="text"
          list="faculty-legend-options"
          value={slot.faculty}
          onChange={(e) => onUpdateSlot(slot.id, { faculty: e.target.value })}
          placeholder="Faculty"
          style={{ fontSize: '0.7rem', padding: '0.15rem 0.3rem' }}
        />
        <input
          type="text"
          value={slot.room}
          onChange={(e) => onUpdateSlot(slot.id, { room: e.target.value })}
          placeholder="Room"
          style={{ fontSize: '0.7rem', padding: '0.15rem 0.3rem' }}
        />
        <div style={{ display: 'flex', gap: '0.25rem', alignItems: 'center' }}>
          <label style={{ fontSize: '0.6rem', color: 'var(--ink-soft)' }}>Hrs</label>
          <input
            type="number"
            min={1}
            max={maxSpanHours}
            value={durationHours}
            onChange={(e) => {

              const hrs = Math.max(1, Math.min(maxSpanHours, Number(e.target.value) || 1));
              const newEndMinutes = startMinutes + hrs * 60;
              const h = Math.floor(newEndMinutes / 60);
              const m = newEndMinutes % 60;
              onUpdateSlot(slot.id, { endTime: `${h}:${String(m).padStart(2, '0')}` });
            }}
            style={{ width: 34, fontSize: '0.65rem', padding: '0.1rem' }}
          />
          <span style={{ fontSize: '0.6rem', color: 'var(--ink-soft)' }}>
            hr{durationHours > 1 ? 's' : ''}
            {slots.length > 1 ? ' (match both)' : ''}
          </span>
        </div>
        <button
          onClick={() => onRemoveSlot(slot.id)}
          className="button-secondary"
          style={{ fontSize: '0.65rem', padding: '0.05rem 0.3rem', alignSelf: 'flex-end' }}
        >
          ✕
        </button>
      </div>
    );
  };

  return (
    <td colSpan={colSpan} style={{ border: '1px solid var(--line)', padding: '0.25rem', verticalAlign: 'top', minWidth: 110 }}>
      {slots.map(renderMiniEditor)}
      {slots.length === 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
          <button
            onClick={() => onAddSlot()}
            className="button-secondary"
            style={{ fontSize: '0.7rem', width: '100%', padding: '0.2rem 0' }}
          >
            + class (1hr)
          </button>
          {maxSpanHours >= 2 && (
            <button
              onClick={() => onAddSlot(undefined, 2)}
              className="button-secondary"
              style={{ fontSize: '0.7rem', width: '100%', padding: '0.2rem 0' }}
              title="Every lab is 2hrs — this spans the next column automatically, no need to touch Hrs"
            >
              + lab (2hr)
            </button>
          )}
        </div>
      )}
      {slots.length === 1 && (
        <button
          onClick={() => onAddSlot(slots[0].group ? undefined : 'Group 1')}
          className="button-secondary"
          style={{ fontSize: '0.65rem', width: '100%', padding: '0.1rem 0' }}
          title="Split this slot into two classes sharing the same time (e.g. a lab's Group 1 / Group 2)"
        >
          + split
        </button>
      )}
    </td>
  );
}

function TimetableGrid({
  days,
  branch,
  semester,
  onChange,
}: {
  days: TimetableDay[];
  branch: string;
  semester: string;
  onChange: (nextDays: TimetableDay[]) => void;
}) {
  const updateSlot = (dayIndex: number, slotId: string, changes: Partial<TimetableSlot>) => {
    const next = [...days];
    next[dayIndex] = {
      ...next[dayIndex],
      slots: next[dayIndex].slots.map((s) => (s.id === slotId ? { ...s, ...changes } : s)),
    };
    onChange(next);
  };

  const addSlot = (dayIndex: number, column: (typeof GRID_TIME_COLUMNS)[number], group?: string, hours?: number) => {
    const next = [...days];

    const existing = next[dayIndex].slots.filter((s) => timeToMinutes(s.startTime) === timeToMinutes(column.startTime));
    const startMinutes = timeToMinutes(column.startTime)!;
    const inheritedEndTime =
      existing.length > 0
        ? existing[0].endTime
        : hours
          ? (() => {
              const endMinutes = startMinutes + hours * 60;
              return `${Math.floor(endMinutes / 60)}:${String(endMinutes % 60).padStart(2, '0')}`;
            })()
          : column.endTime;
    const newSlot: TimetableSlot = {
      ...emptySlot(),
      startTime: column.startTime,
      endTime: inheritedEndTime,
      ...(group ? { group } : {}),
    };

    const updatedSlots = next[dayIndex].slots.map((s) =>
      group && existing.length === 1 && s.id === existing[0].id && !s.group ? { ...s, group: 'Group 1' } : s,
    );
    next[dayIndex] = { ...next[dayIndex], slots: [...updatedSlots, newSlot] };
    onChange(next);
  };

  const removeSlot = (dayIndex: number, slotId: string) => {
    const next = [...days];
    next[dayIndex] = { ...next[dayIndex], slots: next[dayIndex].slots.filter((s) => s.id !== slotId) };
    onChange(next);
  };

  const unmatchedByDay = days.map((d) =>
    d.slots.filter((s) => !GRID_TIME_COLUMNS.some((c) => timeToMinutes(c.startTime) === timeToMinutes(s.startTime))),
  );
  const hasUnmatched = unmatchedByDay.some((s) => s.length > 0);

  const renderDayCells = (dayData: TimetableDay, dayIndex: number) => {
    const cells: ReactElement[] = [];
    let colIndex = 0;
    while (colIndex < GRID_TIME_COLUMNS.length) {
      const column = GRID_TIME_COLUMNS[colIndex];
      const startSlots = dayData.slots.filter((s) => timeToMinutes(s.startTime) === timeToMinutes(column.startTime));
      const maxSpanHours = GRID_TIME_COLUMNS.length - colIndex;
      let span = 1;
      if (startSlots.length > 0) {
        const startMinutes = timeToMinutes(column.startTime)!;
        const maxEndMinutes = Math.max(
          ...startSlots.map((s) => timeToMinutes(s.endTime) ?? timeToMinutes(column.endTime)!),
        );
        span = Math.max(1, Math.min(Math.round((maxEndMinutes - startMinutes) / 60), maxSpanHours));
      }
      cells.push(
        <GridCell
          key={column.label}
          colSpan={span}
          maxSpanHours={maxSpanHours}
          slots={startSlots}
          branch={branch}
          semester={semester}
          column={column}
          onUpdateSlot={(slotId, changes) => updateSlot(dayIndex, slotId, changes)}
          onAddSlot={(group, hours) => addSlot(dayIndex, column, group, hours)}
          onRemoveSlot={(slotId) => removeSlot(dayIndex, slotId)}
        />,
      );
      colIndex += span;
    }
    return cells;
  };

  return (
    <div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '0.75rem' }}>
          <thead>
            <tr>
              <th style={{ border: '1px solid var(--line)', padding: '0.25rem', background: 'var(--panel-bg, #f5f5f5)' }} />
              {GRID_TIME_COLUMNS.map((c) => (
                <th
                  key={c.label}
                  style={{ border: '1px solid var(--line)', padding: '0.25rem', background: 'var(--panel-bg, #f5f5f5)', fontWeight: 600 }}
                >
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {days.map((dayData, dayIndex) => (
              <tr key={dayData.day}>
                <th
                  style={{
                    border: '1px solid var(--line)',
                    padding: '0.25rem',
                    background: 'var(--panel-bg, #f5f5f5)',
                    fontWeight: 600,
                  }}
                >
                  {GRID_DAY_LABELS[dayData.day] ?? dayData.day}
                </th>
                {renderDayCells(dayData, dayIndex)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p style={{ fontSize: '0.7rem', color: 'var(--ink-soft)', marginTop: '0.4rem' }}>
        For a 2-3hr lab, add the class in its FIRST hour column, then bump "Hrs" on that class —
        it'll widen to cover the right number of columns automatically.
      </p>

      {hasUnmatched && (
        <div style={{ marginTop: '1rem', padding: '0.75rem', border: '1px dashed var(--line)', borderRadius: 6 }}>
          <p style={{ fontSize: '0.75rem', color: 'var(--ink-soft)', marginTop: 0 }}>
            These classes have a time outside the 9 standard columns above (a makeup class, or data
            saved before this grid existed) — still saved and editable, just shown separately so the
            grid above stays a clean weekly view.
          </p>
          {days.map((dayData, dayIndex) =>
            unmatchedByDay[dayIndex].length > 0 ? (
              <div key={dayData.day} style={{ marginTop: '0.5rem' }}>
                <strong style={{ fontSize: '0.8rem' }}>{dayData.day}</strong>
                {unmatchedByDay[dayIndex].map((slot) => (
                  <SlotRow
                    key={slot.id}
                    slot={slot}
                    branch={branch}
                    semester={semester}
                    onChange={(changes) => updateSlot(dayIndex, slot.id, changes)}
                    onRemove={() => removeSlot(dayIndex, slot.id)}
                  />
                ))}
              </div>
            ) : null,
          )}
        </div>
      )}
    </div>
  );
}

function TimetableEditor() {

  const [rosterSections, setRosterSections] = useState<{ branch: string; section: string }[]>([]);
  useEffect(() => {
    getDocs(collection(db, 'roster')).then((snap) => {
      const seen = new Set<string>();
      const list: { branch: string; section: string }[] = [];
      snap.docs.forEach((d) => {
        const data = d.data() as { branch?: string; section?: string };
        if (!data.branch || !data.section) return;
        const key = `${data.branch}|${data.section}`;
        if (!seen.has(key)) {
          seen.add(key);
          list.push({ branch: data.branch, section: data.section });
        }
      });
      setRosterSections(list);
    });
  }, []);

  const [curriculumLookup, setCurriculumLookup] = useState<Map<string, string>>(new Map());
  const [curriculumLoading, setCurriculumLoading] = useState(true);
  useEffect(() => {
    getDocs(collection(db, 'curriculum')).then((snap) => {
      const map = new Map<string, string>();
      snap.docs.forEach((d) => {
        const data = d.data() as { branch?: string; code?: string; name?: string };
        if (!data.branch || !data.code || !data.name) return;
        const key = `${data.branch}|${data.code.replace(/\s+/g, '').toUpperCase()}`;
        map.set(key, data.name);
      });
      setCurriculumLookup(map);
      setCurriculumLoading(false);
    });
  }, []);

  const [branch, setBranch] = useState('');
  const [semester, setSemester] = useState('');
  const [section, setSection] = useState('');
  const [days, setDays] = useState<TimetableDay[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const [existed, setExisted] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importRawText, setImportRawText] = useState('');
  const [showImportRawText, setShowImportRawText] = useState(false);

  const handleImportFromScan = async (file: File) => {
    if (!days) {
      setStatus('Load a section first (Branch/Semester/Section above), then import a scan into it.');
      return;
    }
    setImporting(true);
    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
    setStatus(isPdf ? 'Rendering the PDF page…' : 'Reading the timetable photo…');
    try {
      let uploadBlob: Blob = file;
      let contentType = file.type || 'image/jpeg';
      if (isPdf) {
        uploadBlob = await renderPdfFirstPageToJpegBlob(file);
        contentType = 'image/jpeg';
        setStatus('Reading the rendered page…');
      }

      const storagePath = `timetableScans/${auth.currentUser?.uid ?? 'unknown'}/${Date.now()}.jpg`;
      const fileRef = ref(storage, storagePath);
      await uploadBytes(fileRef, uploadBlob, { contentType });

      const extractTimetableInfo = httpsCallable<
        {storagePath: string; bucket: string},
        {rawText: string; slots: {day: string; startTime: string; endTime: string; rawText: string}[]}
      >(functions, 'extractTimetableInfo');

      const bucket = import.meta.env.VITE_FIREBASE_STORAGE_BUCKET as string;
      const result = await extractTimetableInfo({storagePath, bucket});
      const {rawText, slots} = result.data;
      setImportRawText(rawText);

      if (slots.length === 0) {
        setStatus(
          'Could not confidently detect the day/time grid in this scan — the full extracted text is available below to transcribe from manually.',
        );
        setShowImportRawText(true);
        return;
      }

      const next: TimetableDay[] = WEEKDAYS.map((day) => ({
        day,
        slots: slots
          .filter((s) => s.day === day)
          .map((s) => ({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            startTime: s.startTime,
            endTime: s.endTime,
            subjectCode: '',
            subjectName: s.rawText,
            faculty: '',
            room: '',
          })),
      }));
      setDays(next);
      setStatus(
        `Imported a rough first pass from the scan — go through every cell below and fix/split the text before saving. This is approximate, not exact.`,
      );
      setShowImportRawText(true);
    } catch (err: any) {
      setStatus(`Import failed: ${err.message}`);
    } finally {
      setImporting(false);
    }
  };

  const [spreadsheetImporting, setSpreadsheetImporting] = useState(false);

  const [bulkExcelImporting, setBulkExcelImporting] = useState(false);
  const [bulkExcelPreview, setBulkExcelPreview] = useState<{ groups: MultiSectionGroup[]; skippedRowCount: number } | null>(null);
  const [bulkExcelSaving, setBulkExcelSaving] = useState(false);

  const [bulkPdfImporting, setBulkPdfImporting] = useState(false);
  const [bulkPdfQueue, setBulkPdfQueue] = useState<{ pageNumber: number; branch: string; semester: string; section: string; days: TimetableDay[]; rawText: string; undetected: boolean }[]>([]);
  const [bulkPdfIndex, setBulkPdfIndex] = useState(0);
  const handleImportFromSpreadsheet = async (file: File) => {
    if (!days) {
      setStatus('Load a section first (Branch/Semester/Section above), then import a sheet into it.');
      return;
    }
    setSpreadsheetImporting(true);
    setStatus('Reading the spreadsheet…');
    try {
      const { days: parsedDays, skippedRowCount } = await parseSpreadsheetFile(file);
      setDays(parsedDays);
      const totalSlots = parsedDays.reduce((sum, d) => sum + d.slots.length, 0);
      setStatus(
        skippedRowCount > 0
          ? `Imported ${totalSlots} classes. ${skippedRowCount} row(s) were skipped — their Day or time columns weren't recognizable. Review below, then save.`
          : `Imported ${totalSlots} classes from the sheet. Review below, then save.`,
      );
    } catch (err: any) {
      setStatus(`Import failed: ${err.message}`);
    } finally {
      setSpreadsheetImporting(false);
    }
  };

  const downloadTimetableTemplate = () => {
    const blob = new Blob([WHOLE_COLLEGE_TIMETABLE_TEMPLATE_CSV], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'whole-college-timetable-template.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadGridTemplate = async () => {
    const XLSX = await import('xlsx');
    const rows = [
      ['Day', '09:00 - 10:00AM', '10:00 - 11:00AM', '11:00AM - 12:00PM'],
      [
        'Monday',
        'Group 1\nAS101\nPHY Lab 1\nND\n\nGroup 2\nEC101\nECE Lab 2\nRDM/SRS',
        'AS102\nCR 6\nPAS F1',
        '',
      ],
      ['Tuesday', 'MS101\nCR 6\nAPS', 'AS102\nCR 6\nPAS F1', 'HS101\nCR 6\nHSS F1'],
    ];
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    sheet['!cols'] = [{ wch: 12 }, { wch: 26 }, { wch: 22 }, { wch: 22 }];
    const workbook = XLSX.utils.book_new();

    XLSX.utils.book_append_sheet(workbook, sheet, 'SEMESTER 1 ECE A');
    const wbout = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
    const blob = new Blob([wbout], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'whole-college-timetable-grid-template.xlsx';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportAllFromSpreadsheet = async (file: File) => {
    if (curriculumLoading) {
      setStatus('Still loading curriculum — wait a second and try choosing the file again.');
      return;
    }
    setBulkExcelImporting(true);
    setStatus('');
    setBulkExcelPreview(null);
    try {
      const result = await parseAnySpreadsheetAllSections(file);
      if (result.groups.length === 0) {
        setStatus('No recognizable section rows found in this sheet.');
        return;
      }

      for (const group of result.groups) {
        for (const day of group.days) {
          for (const slot of day.slots) {
            const key = `${group.branch}|${slot.subjectCode.replace(/\s+/g, '').toUpperCase()}`;
            const name = curriculumLookup.get(key);
            if (name) slot.subjectName = name;
          }
        }
      }
      setBulkExcelPreview(result);
    } catch (err: any) {
      setStatus(`Import failed: ${err.message}`);
    } finally {
      setBulkExcelImporting(false);
    }
  };

  const updateBulkExcelGroupField = (index: number, field: 'branch' | 'section', value: string) => {
    if (!bulkExcelPreview) return;
    const nextGroups = [...bulkExcelPreview.groups];
    nextGroups[index] = { ...nextGroups[index], [field]: value };
    setBulkExcelPreview({ ...bulkExcelPreview, groups: nextGroups });
  };

  const [expandedGroupIndex, setExpandedGroupIndex] = useState<number | null>(null);

  const setBulkGroupDays = (groupIndex: number, nextDays: TimetableDay[]) => {
    if (!bulkExcelPreview) return;
    const nextGroups = [...bulkExcelPreview.groups];
    nextGroups[groupIndex] = { ...nextGroups[groupIndex], days: nextDays };
    setBulkExcelPreview({ ...bulkExcelPreview, groups: nextGroups });
  };

  const handleConfirmBulkExcelSave = async () => {
    if (!bulkExcelPreview) return;
    const unmatched = bulkExcelPreview.groups.filter((g) => {
      const realSections = rosterSections.filter((r) => r.branch === g.branch).map((r) => r.section);
      return realSections.length > 0 && !realSections.includes(g.section);
    });
    if (unmatched.length > 0) {
      setStatus(
        `Fix ${unmatched.length} row(s) before saving — each Section dropdown must be set to a real roster value (rows: ${unmatched.map((g) => `${g.branch} Sem ${g.semester}`).join(', ')}).`,
      );
      return;
    }
    if (
      !confirm(
        `Save ${bulkExcelPreview.groups.length} section(s)? This replaces the existing schedule for each one listed, entirely.`,
      )
    )
      return;
    setBulkExcelSaving(true);
    let savedCount = 0;
    try {

      const roomAliases = await loadRoomAliases();
      for (const group of bulkExcelPreview.groups) {
        const id = timetableDocId(group.branch, group.semester, group.section);
        const sortedDays = group.days.map((d) => ({
          day: d.day,
          slots: [...d.slots]
            .filter((s) => s.startTime && s.subjectCode)
            .sort((a, b) => a.startTime.localeCompare(b.startTime)),
        }));
        await setDoc(doc(db, 'timetable', id), {
          branch: group.branch,
          semester: group.semester,
          section: group.section,
          days: cleanDays(sortedDays, roomAliases),
          updatedAt: serverTimestamp(),
        });
        savedCount++;
      }
      setStatus(`Saved ${savedCount} section(s) from the sheet.`);
      setBulkExcelPreview(null);
    } catch (err: any) {
      setStatus(`Saved ${savedCount} of ${bulkExcelPreview.groups.length} before this failed: ${err.message}`);
    } finally {
      setBulkExcelSaving(false);
    }
  };

  const handleImportAllFromPdf = async (file: File) => {
    setBulkPdfImporting(true);
    setStatus('Rendering PDF pages…');
    try {
      const blobs = await renderAllPdfPagesToJpegBlobs(file);
      const queue: typeof bulkPdfQueue = [];
      const extractTimetableInfo = httpsCallable<
        {storagePath: string; bucket: string},
        {rawText: string; slots: {day: string; startTime: string; endTime: string; rawText: string}[]}
      >(functions, 'extractTimetableInfo');
      const bucket = import.meta.env.VITE_FIREBASE_STORAGE_BUCKET as string;

      for (let i = 0; i < blobs.length; i++) {
        setStatus(`Reading page ${i + 1} of ${blobs.length}…`);
        const storagePath = `timetableScans/${auth.currentUser?.uid ?? 'unknown'}/${Date.now()}-page${i + 1}.jpg`;
        const fileRef = ref(storage, storagePath);
        await uploadBytes(fileRef, blobs[i], { contentType: 'image/jpeg' });
        const result = await extractTimetableInfo({ storagePath, bucket });
        const { rawText, slots } = result.data;
        const detected = detectSectionFromHeaderText(rawText);
        const pageDays: TimetableDay[] = WEEKDAYS.map((day) => ({
          day,
          slots: slots
            .filter((s) => s.day === day)
            .map((s) => ({
              id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              startTime: s.startTime,
              endTime: s.endTime,
              subjectCode: '',
              subjectName: s.rawText,
              faculty: '',
              room: '',
            })),
        }));
        queue.push({
          pageNumber: i + 1,
          branch: detected?.branch ?? '',
          semester: detected ? String(detected.semester) : '',
          section: detected?.section ?? '',
          days: pageDays,
          rawText,
          undetected: !detected,
        });
      }

      setBulkPdfQueue(queue);
      setBulkPdfIndex(0);
      if (queue.length > 0) {
        loadBulkPdfQueueItem(queue[0]);
      }
      const undetectedCount = queue.filter((q) => q.undetected).length;
      setStatus(
        `Read ${queue.length} page(s).${undetectedCount > 0 ? ` ${undetectedCount} page(s) couldn't auto-detect their section — fill in Branch/Semester/Section by hand for those.` : ''} Reviewing page 1 of ${queue.length} below.`,
      );
    } catch (err: any) {
      setStatus(`Import failed: ${err.message}`);
    } finally {
      setBulkPdfImporting(false);
    }
  };

  function loadBulkPdfQueueItem(item: (typeof bulkPdfQueue)[number]) {
    setBranch(item.branch);
    setSemester(item.semester);
    setSection(item.section);
    setDays(item.days);
    setExisted(false);
    setImportRawText(item.rawText);
  }

  const advanceBulkPdfQueue = () => {
    const nextIndex = bulkPdfIndex + 1;
    if (nextIndex < bulkPdfQueue.length) {
      setBulkPdfIndex(nextIndex);
      loadBulkPdfQueueItem(bulkPdfQueue[nextIndex]);
      setStatus(`Reviewing page ${nextIndex + 1} of ${bulkPdfQueue.length}.`);
    } else {
      setBulkPdfQueue([]);
      setBulkPdfIndex(0);
      setStatus('Finished reviewing all pages.');
    }
  };

  const handleLoad = async () => {
    if (!branch.trim() || !semester.trim() || !section.trim()) {
      setStatus('Fill in Branch, Semester, and Section first.');
      return;
    }
    setLoading(true);
    setStatus('');
    try {
      const id = timetableDocId(branch.trim().toUpperCase(), Number(semester), section.trim());
      const snap = await getDoc(doc(db, 'timetable', id));
      if (snap.exists()) {
        const data = snap.data();

        const existingDays: TimetableDay[] = data.days ?? [];
        const merged = WEEKDAYS.map(
          (day) => existingDays.find((d) => d.day === day) ?? { day, slots: [] },
        );
        setDays(merged);
        setExisted(true);
        setStatus(`Loaded the existing timetable for ${id} — edit below, then save.`);
      } else {
        setDays(emptyWeek());
        setExisted(false);
        setStatus(`No existing timetable for ${id} yet — starting blank.`);
      }
    } catch (err: any) {
      setStatus(`Couldn't load: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!days) return;
    if (!branch.trim() || !semester.trim() || !section.trim()) {

      setStatus('Fill in Branch, Semester, and Section before saving — this page could not auto-detect one or more of them.');
      return;
    }
    const id = timetableDocId(branch.trim().toUpperCase(), Number(semester), section.trim());
    if (
      !confirm(
        `Save this as the timetable for ${id}? This ${existed ? 'replaces the existing schedule for this section' : 'creates a new schedule'} entirely.`,
      )
    )
      return;

    setSaving(true);
    setStatus('Saving...');
    try {
      const sortedDays = days.map((d) => ({
        day: d.day,
        slots: [...d.slots]
          .filter((s) => s.startTime && s.subjectCode)
          .sort((a, b) => a.startTime.localeCompare(b.startTime)),
      }));
      const roomAliases = await loadRoomAliases();
      await setDoc(doc(db, 'timetable', id), {
        branch: branch.trim().toUpperCase(),
        semester: Number(semester),
        section: section.trim(),
        days: cleanDays(sortedDays, roomAliases),
        updatedAt: serverTimestamp(),
      });
      setExisted(true);
      if (bulkPdfQueue.length > 0) {

        setStatus(`Saved ${branch.trim().toUpperCase()} Sem ${semester} ${section.trim()}.`);
        advanceBulkPdfQueue();
      } else {
        setStatus(`Saved. Students in ${branch.trim().toUpperCase()} Sem ${semester} ${section.trim()} will see this immediately.`);
      }
    } catch (err: any) {
      setStatus(`Save failed: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card" style={{ width: 760, padding: '2.5rem', margin: '3rem auto' }}>
      <FacultyDatalist />
      <h1 style={{ fontSize: '1.5rem' }}>Edit Timetable</h1>
      <p style={{ fontSize: '0.85rem', color: 'var(--ink-soft)' }}>
        Load a section's current schedule and edit just what changed — much faster than
        re-entering the whole week every time the timetable shifts.
      </p>

      <div style={{ marginTop: '1.5rem', padding: '1rem', border: '1px solid var(--border, #ddd)', borderRadius: 8 }}>
        <h2 style={{ fontSize: '1.05rem', marginTop: 0 }}>Upload the whole college at once</h2>
        <p style={{ fontSize: '0.8rem', color: 'var(--ink-soft)' }}>
          For a single Excel/CSV or PDF covering every section, instead of doing this one class at a
          time below.
        </p>

        <label>
          Whole-college Excel/CSV — either a grid sheet per section (matching your existing timetable
          layout, recommended) or one row per class{curriculumLoading ? ' — loading curriculum, one moment...' : ''}
        </label>
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <input
            type="file"
            accept=".xlsx,.xls,.csv"
            disabled={bulkExcelImporting || curriculumLoading}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleImportAllFromSpreadsheet(file);
              e.target.value = '';
            }}
          />
          <button type="button" onClick={downloadGridTemplate}>
            Download grid template
          </button>
          <button type="button" onClick={downloadTimetableTemplate}>
            Download row template
          </button>
        </div>

        {bulkExcelPreview && (
          <div style={{ marginTop: '1rem' }}>
            <p style={{ fontSize: '0.85rem' }}>
              Found {bulkExcelPreview.groups.length} section(s)
              {bulkExcelPreview.skippedRowCount > 0
                ? ` (${bulkExcelPreview.skippedRowCount} row(s) skipped — unrecognizable Day/Branch/Semester)`
                : ''}
              — check each Branch/Section below against your real roster before saving. A row
              marked "no roster match" means no student's profile actually has that exact
              branch+section combination, so nobody would ever see that timetable.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {bulkExcelPreview.groups.map((g, i) => {
                const realSectionsForBranch = Array.from(
                  new Set(rosterSections.filter((r) => r.branch === g.branch).map((r) => r.section)),
                );
                const hasMatch = realSectionsForBranch.includes(g.section);
                const isExpanded = expandedGroupIndex === i;
                return (
                  <div key={i}>
                  <div
                    style={{
                      display: 'flex',
                      gap: '0.5rem',
                      alignItems: 'center',
                      padding: '0.5rem',
                      border: '1px solid var(--line)',
                      borderRadius: 4,
                      fontSize: '0.85rem',
                    }}
                  >
                    <input
                      type="text"
                      value={g.branch}
                      onChange={(e) => updateBulkExcelGroupField(i, 'branch', e.target.value.toUpperCase())}
                      style={{ width: 70 }}
                    />
                    <span>Sem {g.semester}</span>
                    <select
                      value={hasMatch ? g.section : ''}
                      onChange={(e) => updateBulkExcelGroupField(i, 'section', e.target.value)}
                      style={{ width: 130 }}
                    >
                      <option value="" disabled>
                        {realSectionsForBranch.length > 0 ? 'Pick the real section...' : `No ${g.branch} students in roster`}
                      </option>
                      {realSectionsForBranch.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                    <span>— {g.days.reduce((sum, d) => sum + d.slots.length, 0)} classes</span>
                    {rosterSections.length > 0 &&
                      (hasMatch ? (
                        <span style={{ color: '#16a34a' }}>✓ matches roster</span>
                      ) : (
                        <span style={{ color: '#b91c1c' }}>
                          ⚠ pick the real section on the left before saving
                        </span>
                      ))}
                    <button
                      type="button"
                      className="button-secondary"
                      style={{ marginLeft: 'auto', fontSize: '0.8rem' }}
                      onClick={() => setExpandedGroupIndex(isExpanded ? null : i)}
                    >
                      {isExpanded ? 'Done editing' : 'Edit classes'}
                    </button>
                  </div>
                  {isExpanded && (
                    <div
                      style={{
                        padding: '0.75rem 0.5rem 0.5rem 1.5rem',
                        borderLeft: '3px solid var(--line)',
                        marginTop: '0.25rem',
                        marginBottom: '0.5rem',
                      }}
                    >
                      <p style={{ fontSize: '0.75rem', color: 'var(--ink-soft)', marginTop: 0 }}>
                        Same grid as the single-section editor below — fix anything the source
                        sheet had wrong before saving.
                      </p>
                      <TimetableGrid
                        days={g.days}
                        branch={g.branch}
                        semester={String(g.semester)}
                        onChange={(nextDays) => setBulkGroupDays(i, nextDays)}
                      />
                    </div>
                  )}
                  </div>
                );
              })}
            </div>
            <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.75rem' }}>
              <button onClick={handleConfirmBulkExcelSave} disabled={bulkExcelSaving}>
                {bulkExcelSaving ? 'Saving…' : `Confirm & Save All ${bulkExcelPreview.groups.length} Section(s)`}
              </button>
              <button
                className="button-secondary"
                onClick={() => setBulkExcelPreview(null)}
                disabled={bulkExcelSaving}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        <label style={{ display: 'block', marginTop: '1.25rem' }}>
          Whole-college PDF (one page per section — approximate, reviewed page-by-page below before
          saving)
        </label>
        <input
          type="file"
          accept=".pdf,application/pdf"
          disabled={bulkPdfImporting}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleImportAllFromPdf(file);
            e.target.value = '';
          }}
        />
        {bulkPdfQueue.length > 0 && (
          <p style={{ fontSize: '0.85rem', marginTop: '0.5rem' }}>
            Reviewing page {bulkPdfIndex + 1} of {bulkPdfQueue.length} in the editor below — check
            Branch/Semester/Section and the detected classes, then click Save to move to the next
            page.{' '}
            <button className="button-secondary" onClick={advanceBulkPdfQueue} style={{ marginLeft: '0.5rem' }}>
              Skip this page
            </button>
          </p>
        )}
      </div>

      <div style={{ display: 'flex', gap: '1rem', marginTop: '1.5rem' }}>
        <div style={{ flex: 1 }}>
          <label>Branch</label>
          <input type="text" value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="e.g. CSE" />
        </div>
        <div style={{ flex: 1 }}>
          <label>Semester</label>
          <input type="number" value={semester} onChange={(e) => setSemester(e.target.value)} placeholder="e.g. 3" />
        </div>
        <div style={{ flex: 1 }}>
          <label>Section</label>
          <input type="text" value={section} onChange={(e) => setSection(e.target.value)} placeholder="e.g. CSE A" />
        </div>
      </div>

      <button onClick={handleLoad} disabled={loading} style={{ width: '100%', marginTop: '1rem' }}>
        {loading ? 'Loading...' : 'Load This Section'}
      </button>

      {days && (
        <div style={{ marginTop: '1rem' }}>
          <label>Import from an Excel/CSV sheet (automatic — Day, Start Time, End Time columns required)</label>
          <input
            type="file"
            accept=".xlsx,.xls,.csv"
            disabled={spreadsheetImporting}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleImportFromSpreadsheet(file);
              e.target.value = '';
            }}
          />

          <label style={{ display: 'block', marginTop: '1rem' }}>
            Import from a timetable photo or PDF (optional — approximate, always review before saving)
          </label>
          <input
            type="file"
            accept="image/*,.pdf,application/pdf"
            disabled={importing}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleImportFromScan(file);
              e.target.value = '';
            }}
          />
          {importRawText && (
            <div style={{ marginTop: '0.5rem' }}>
              <button
                onClick={() => setShowImportRawText((v) => !v)}
                className="button-secondary"
                style={{ fontSize: '0.8rem' }}
              >
                {showImportRawText ? 'Hide' : 'Show'} full scanned text
              </button>
              {showImportRawText && (
                <pre
                  style={{
                    marginTop: '0.5rem',
                    padding: '0.75rem',
                    background: 'var(--panel-bg, #f5f5f5)',
                    borderRadius: 6,
                    fontSize: '0.75rem',
                    whiteSpace: 'pre-wrap',
                    maxHeight: 200,
                    overflowY: 'auto',
                  }}
                >
                  {importRawText}
                </pre>
              )}
            </div>
          )}
        </div>
      )}

      {status && <p style={{ marginTop: '1rem', fontSize: '0.9rem' }}>{status}</p>}

      {days && (
        <>
          <TimetableGrid days={days} branch={branch} semester={semester} onChange={setDays} />

          <button onClick={handleSave} disabled={saving} style={{ width: '100%', marginTop: '1.5rem' }}>
            {saving ? 'Publishing...' : 'Publish Timetable'}
          </button>
        </>
      )}
    </div>
  );
}

export default TimetableEditor;
