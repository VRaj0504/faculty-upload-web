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

// Must match src/firebase/timetableService.ts's timetableDocId() in the
// mobile app exactly — same three pieces, same order, same separator.
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

// Fixed-name subjects for a branch+semester, from the same static list
// CurriculumUpload.tsx seeds Firestore from — used here to populate a
// real dropdown instead of a free-text Subject Code field, so a typo
// can no longer produce a code that doesn't exist. Electives are
// deliberately absent from `curriculum` (their real name varies per
// student), which is why the dropdown always also offers an "Other /
// elective" escape hatch that falls back to free text for that one row.
function subjectOptionsFor(branchValue: string, semesterValue: string): { code: string; name: string }[] {
  const branchKey = branchValue.trim().toUpperCase() as keyof typeof curriculum;
  const semesterNum = Number(semesterValue);
  if (!curriculum[branchKey] || !semesterNum) return [];
  return curriculum[branchKey][semesterNum] ?? [];
}

// The aSc PDFs/Excel this data was originally transcribed from write
// codes WITH a space ("AS 101"), but curriculum.ts stores them without
// one ("AS101") — a straight === comparison treats those as two
// different codes and wrongly falls back to "Other", even though it's
// a perfectly real, listed subject. Comparing with spaces and case
// stripped fixes that without changing what's actually stored.
function normalizeCode(code: string): string {
  return code.replace(/\s+/g, '').toUpperCase();
}

function matchCurriculumOption(
  options: { code: string; name: string }[],
  code: string,
): { code: string; name: string } | undefined {
  return options.find((o) => normalizeCode(o.code) === normalizeCode(code));
}

// Faculty initials + full name, for the shared <datalist> below —
// typing still works (so a genuinely new or multi-faculty combo like
// "ND/BP" is never blocked), but anyone already in the legend now
// shows up as a suggestion instead of needing to be retyped from
// memory.
const FACULTY_DATALIST_OPTIONS = Object.entries(FACULTY_LEGEND).map(([initials, name]) => ({
  initials,
  name,
}));

// One editable class row — Subject Code as a curriculum-driven dropdown
// (auto-fills Subject Name, with an "Other / elective" escape hatch to
// free text for anything not in the fixed list), Faculty as a free-text
// field suggested from FACULTY_LEGEND via the shared datalist. Used by
// both the single-section editor below and the bulk whole-college
// preview's per-section slot editor, so a typo is caught in either
// workflow the same way, not just the slower one.
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
        // No branch/semester picked yet, or nothing in the static
        // curriculum list for it (e.g. MNC) — fall back to free text
        // rather than an empty dropdown.
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
            // Both fields land in ONE call — updating them as two
            // separate calls (subjectCode, then subjectName) each
            // computed their own copy of the slot from the same
            // not-yet-updated state, so the second call silently threw
            // away the first's change. A single combined update can't
            // do that.
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

// Rendered once, top-level, so every SlotRow's faculty <input
// list="faculty-legend-options"> resolves regardless of which editor
// (single-section or bulk-preview) it's inside.
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

// The 9 time columns every real IIIT Surat timetable uses (see the aSc
// exports) — fixed, not typed per class, which is the whole point: a
// faculty member picks a DAY × COLUMN cell instead of typing "9:00" and
// "10:00" into two separate free-text boxes, so a mistyped or
// transposed time can no longer happen at all for anything that fits
// this standard grid. startTime/endTime here are what actually gets
// saved on the slot — same "H:MM" shape normalizeTimeCell already
// produces elsewhere, so a grid-entered class looks identical in
// Firestore to one that came in through spreadsheet/PDF import.
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

// "9:00" and "09:00" are the same time but different strings — imported
// sheets/PDFs and hand-typed times don't reliably agree on padding, so
// every column match has to go through minutes rather than a straight
// string compare.
function timeToMinutes(raw: string): number | null {
  const match = raw.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
}

// One DAY × COLUMN cell — 0, 1, or 2 classes (2 for a lab split into
// Group 1 / Group 2, or a Div. 1 / Div. 2 elective split). Each present
// class is an inline mini-editor (Subject Code dropdown, Faculty
// autocomplete, Room) with no time fields at all, since the column
// already fixes those. This is the piece that removes the "typed the
// wrong time into the wrong day's row" mistake class entirely, not just
// the subject/faculty typo class SlotRow already handles.
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
    // Defaults to 1hr if the slot's endTime is blank/unparseable (a
    // brand-new slot) rather than crashing on the arithmetic below.
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
              // Both fields in ONE call — see SlotRow's identical
              // comment above for why two separate calls here silently
              // dropped the subjectCode change.
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
              // A 2-3hr lab (11-2, 1-3, etc.) is just this slot's endTime
              // pushed out — bumping this to 2 or 3 makes the cell span
              // that many time columns below, same as the real printed
              // timetable. Clamped to how many columns are actually left
              // in the day from this one.
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

// The full week as a real grid — Days as rows, the 9 fixed slots as
// columns — instead of a flat "add class" list per day. This is what
// both the single-section editor and the bulk whole-college preview's
// per-section editor render now: pick Branch/Semester/Section, the grid
// appears (blank or pre-filled from what's already saved), edit cells
// directly, publish.
//
// A slot whose time doesn't land on any of the 9 standard columns
// (a one-off makeup class, or old data saved before this grid existed)
// is never silently dropped — it's listed below the grid, still fully
// editable via the same SlotRow used elsewhere, so nothing saved
// through the old flat editor becomes invisible just because this grid
// is now the default view.
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
    // Splitting an existing slot into two groups inherits ITS current
    // duration (which may already be a 2-3hr lab) rather than resetting
    // to a fresh 1hr block — a Group 2 added onto an already-widened
    // Group 1 lab should cover the same span, not just its first hour.
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
    // Splitting an existing single slot into two also labels the first
    // one "Group 1" if it wasn't already labeled, so the pair reads
    // clearly rather than one being blank and the other "Group 1".
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

  // Slots whose time doesn't match any of the 9 standard columns,
  // grouped by day index so they can still be edited (not lost) below
  // the grid.
  const unmatchedByDay = days.map((d) =>
    d.slots.filter((s) => !GRID_TIME_COLUMNS.some((c) => timeToMinutes(c.startTime) === timeToMinutes(s.startTime))),
  );
  const hasUnmatched = unmatchedByDay.some((s) => s.length > 0);

  // Builds one day's <td> cells left to right. A lab that's been
  // widened past 1hr (via the "Hrs" control in GridCell) needs a real
  // HTML colSpan across however many columns it now covers — and every
  // column it covers must NOT get its own separate <td>, or the row
  // would render too many cells and the whole table would misalign.
  // colIndex is advanced by the span every time a cell is placed,
  // whether that span is 1 (an ordinary class, or an empty "+ class"
  // column) or more (a real lab).
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
  // Loaded once so the bulk-import preview can show which section
  // values actually exist for a branch in the real roster — a PDF or
  // spreadsheet's own title ("SEMESTER 3 CSE B") uses whatever letter
  // convention that document happens to use, which is NOT guaranteed
  // to match how sections are actually labeled in student profiles
  // (e.g. a roster using "CSE1"/"CSE2" instead of "A"/"B"). Without
  // this cross-check, a wrong auto-detected section silently saves a
  // timetable that matches zero real students.
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

  // Loaded once so imported timetable slots can be enriched with the
  // real subject name, not just the bare code a PDF/spreadsheet shows
  // (e.g. "CS 304" -> "Database Management Systems"). Keyed by
  // branch + a normalized code (spaces stripped, uppercased) since a
  // timetable's own code formatting ("CS 304") doesn't always match
  // curriculum's stored formatting ("CS304") exactly.
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

  // Handles both a photo AND a PDF — a PDF's first page is rendered to a
  // JPEG client-side (see timetableImport.ts) and fed through the exact
  // same Vision OCR call as a photo would be. Same accuracy story as a
  // photo either way: a reasonable first pass, always reviewed before
  // saving, never trusted outright.
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

      // Best-effort only — this replaces whatever's currently in the
      // editor with the scan's guesses, on the assumption this is being
      // used to start a fresh timetable from a new emailed photo/PDF,
      // not to patch an existing one. Every cell still needs to be
      // checked against the original document before saving; nothing
      // here is trusted as final.
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

  // Fully automatic — no OCR guessing involved. Parses an .xlsx/.xls/.csv
  // deterministically (see timetableImport.ts) straight into the editor's
  // day/slot structure. Still shown in the editor rather than saved
  // directly, so a typo'd source column or unexpected day name is caught
  // before it reaches students, but there's no per-cell reconstruction
  // needed the way a scan import has.
  const [spreadsheetImporting, setSpreadsheetImporting] = useState(false);

  // Bulk Excel/CSV: parsed groups sit here for review before any
  // Firestore write happens — nothing gets saved until "Confirm & Save
  // All" is clicked, same "show it before committing" principle as the
  // single-section import, just applied to many sections at once instead
  // of many cells within one section.
  const [bulkExcelImporting, setBulkExcelImporting] = useState(false);
  const [bulkExcelPreview, setBulkExcelPreview] = useState<{ groups: MultiSectionGroup[]; skippedRowCount: number } | null>(null);
  const [bulkExcelSaving, setBulkExcelSaving] = useState(false);

  // Bulk PDF: each page is OCR'd into a queue, then reviewed ONE AT A
  // TIME through the exact same branch/semester/section/days editor
  // already used for a single-section import — never auto-saved, since
  // OCR per page is exactly as approximate as the single-photo import
  // already is, just repeated across every page.
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

  // Bulk Excel/CSV — parses the whole sheet into per-section groups and
  // shows them for review; nothing is saved until handleConfirmBulkExcel
  // runs. Independent of the single-section Branch/Semester/Section
  // fields above — a bulk import covers many sections, so it doesn't
  // make sense to gate it on one section being "loaded" first.
  const downloadTimetableTemplate = () => {
    const blob = new Blob([WHOLE_COLLEGE_TIMETABLE_TEMPLATE_CSV], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'whole-college-timetable-template.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  // A grid-shaped sheet, one per section, matching exactly how the
  // college's own aSc-exported timetable already looks -- easier for
  // faculty to fill in or edit than the flat row-per-slot CSV above,
  // since it's the same shape they already read and think in. Built
  // client-side with the same xlsx library already used to parse
  // uploads, from real, already-verified rows (ECE Sem1 Section A),
  // not placeholder text.
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
    // The sheet name IS what tells the importer which section this is
    // -- "SEMESTER <n> <branch> <section>", matched by
    // detectSectionFromHeaderText. Faculty rename this per section
    // when they duplicate the sheet for a real upload.
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
      // Fill in each slot's real subject name from Curriculum — a
      // timetable source only ever has the bare code ("CS 304"), never
      // the full name, so this is the only place that name comes from.
      // A slot whose code has no curriculum match at all (e.g. a
      // division/elective code not yet in Curriculum) is left with an
      // empty name rather than a guess.
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

  // Lets the reviewer correct a detected group's branch/section before
  // saving anything — needed because auto-detection reads whatever
  // convention the SOURCE FILE happens to use, which isn't guaranteed
  // to match the roster's actual section labels.
  const updateBulkExcelGroupField = (index: number, field: 'branch' | 'section', value: string) => {
    if (!bulkExcelPreview) return;
    const nextGroups = [...bulkExcelPreview.groups];
    nextGroups[index] = { ...nextGroups[index], [field]: value };
    setBulkExcelPreview({ ...bulkExcelPreview, groups: nextGroups });
  };

  // Which group (if any) is expanded into the full day/slot editor below
  // its summary row — only one at a time, so reviewing 11 sections stays
  // manageable rather than showing every slot of every section at once.
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
      // Room-name fixes made in Room names are applied on every save, so
      // a re-imported sheet can't bring a wrong room back.
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

  // Bulk PDF — OCRs every page, tries to auto-detect each page's
  // section from its own title text, and queues them up for one-at-a-
  // time review through the normal single-section editor below (see
  // loadBulkPdfQueueItem). Each page still costs one Vision OCR call,
  // same as importing that many photos individually would.
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

  // Advances the review queue after either a manual "Skip" or right
  // after handleSave succeeds while a batch is active (wired in below) —
  // same page-by-page review flow either way, just two different ways
  // to move past the current page.
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
        // Ensure every weekday is present even if the existing doc is
        // missing one (e.g. it only ever had Mon-Thu filled in) — editing
        // should never lose the ability to add a day that was empty
        // before.
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

  // Sorts each day's slots by start time before saving — the editor lets
  // you add slots in any order, but the mobile app's TimetableScreen
  // renders whatever order they're stored in, so this keeps the display
  // correctly chronological regardless of entry order here.
  const handleSave = async () => {
    if (!days) return;
    if (!branch.trim() || !semester.trim() || !section.trim()) {
      // Most relevant during bulk PDF review — a page whose section
      // couldn't be auto-detected leaves these blank, and saving with
      // an incomplete id would silently create a malformed timetable
      // doc no student's app would ever query correctly.
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
          .filter((s) => s.startTime && s.subjectCode) // drop genuinely blank rows
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
        // Mid-batch-review save — move straight to the next queued page
        // instead of leaving the reviewer to notice and click into it.
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
