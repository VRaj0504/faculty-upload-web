// Pure helpers for the Exam Schedule tab (ExamSchedule.tsx) — no React, no Firebase, so the
// messy part (turning whatever a spreadsheet's cells look like into clean
// ISO dates and 24h times) can be reasoned about and tested on its own.

export type ExamEntry = {
  date: string; // YYYY-MM-DD — a plain string, never a Date, so timezones can't shift an exam by a day
  startTime: string; // HH:MM, 24h
  endTime: string; // HH:MM, 24h — '' when the sheet only gave a start time
  subjectCode: string;
  subjectName: string;
  venue: string;
};

// Must match EXAM_TYPE_LABELS in functions/src/examSheetExtraction.ts and
// EXAM_TYPE_ORDER in the app's src/firebase/examScheduleService.ts.
// "-repeaters" sheets are the separate date sheet some semesters publish for
// students repeating a course (different subjects, sometimes different
// times) — kept as their own sheet so regular students never see it mixed
// into theirs.
export const EXAM_TYPES = [
  { id: 'quiz', label: 'Quiz / Internal' },
  { id: 'midsem', label: 'Mid Semester' },
  { id: 'midsem-repeaters', label: 'Mid Semester (Repeaters)' },
  { id: 'endsem', label: 'End Semester' },
  { id: 'endsem-repeaters', label: 'End Semester (Repeaters)' },
  { id: 'supplementary', label: 'Supplementary / Re-exam' },
] as const;
export type ExamTypeId = (typeof EXAM_TYPES)[number]['id'];

// MNC has its own sheets; a student of MNC reads the MNC sheet and falls back
// to the CSE one when none has been published for that exam.
// One class's date sheet, as returned by the PDF/email import and as
// stored in the `examSchedules` collection.
export type ExamGroup = {
  branch: string;
  semester: number;
  examType: ExamTypeId;
  examTypeLabel: string;
  entries: ExamEntry[];
};

// Which branch sheets one publish writes to. A paper two or three branches
// sit together is entered once and written to each real branch's own doc —
// Firestore only ever stores CSE, ECE or MNC as a branch value.
export const EXAM_BRANCH_CHOICES = [
  { value: 'CSE', label: 'CSE' },
  { value: 'ECE', label: 'ECE' },
  { value: 'MNC', label: 'MNC (Mathematics & Computing)' },
  { value: 'BOTH', label: 'CSE + ECE — common exam' },
  { value: 'CSE_MNC', label: 'CSE + MNC — common exam' },
  { value: 'ALL', label: 'All three branches — common exam' },
] as const;

export function branchesOf(choice: string): string[] {
  switch (choice) {
    case 'BOTH': return ['CSE', 'ECE'];
    // MNC first: the server's notification for a CSE sheet skips MNC students
    // when an MNC sheet for the same exam already exists, so they get one ping.
    case 'CSE_MNC': return ['MNC', 'CSE'];
    case 'ALL': return ['MNC', 'CSE', 'ECE'];
    default: return choice ? [choice] : [];
  }
}
export const isMultiBranch = (choice: string) => branchesOf(choice).length > 1;
export const branchChoiceLabel = (choice: string) => branchesOf(choice).join(' & ');

export function examDocId(branch: string, semester: number, examType: string): string {
  return `${branch}-${semester}-${examType}`;
}

const pad = (n: number) => String(n).padStart(2, '0');

function isRealDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

// Accepts an Excel serial number, an ISO string, or the day-first formats
// Indian date sheets actually use (12/11/2026, 12-11-26, 12 Nov 2026,
// 12th November 2026, Thu, 12-Nov-2026). Day-first is deliberate: 03/04/2026
// on an IIIT Surat sheet means 3 April, not March 4. Returns '' (never a
// guess) when it can't tell — the preview table then shows that row as
// needing a fix instead of silently saving a wrong date.
export function parseExamDate(value: unknown): string {
  if (value === null || value === undefined || value === '') return '';

  if (value instanceof Date) {
    return isNaN(value.getTime()) ? '' : `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }

  if (typeof value === 'number') {
    // Excel serial date (days since 1899-12-30). Anything below ~1 or
    // above ~100000 isn't a plausible date, so treat it as not-a-date.
    if (value < 1 || value > 100000) return '';
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(value) * 86400000);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }

  let s = String(value).trim();
  if (!s) return '';
  s = s.replace(/^[A-Za-z]{3,9}day\s*[,-]?\s*/i, '').replace(/^(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)\s*[,.-]?\s*/i, '');
  s = s.replace(/(\d)(st|nd|rd|th)\b/gi, '$1');

  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return isRealDate(y, mo, d) ? `${y}-${pad(mo)}-${pad(d)}` : '';
  }

  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (m) {
    const d = Number(m[1]);
    const mo = Number(m[2]);
    let y = Number(m[3]);
    if (y < 100) y += 2000;
    return isRealDate(y, mo, d) ? `${y}-${pad(mo)}-${pad(d)}` : '';
  }

  m = s.match(/^(\d{1,2})[\s\-/.,]*([A-Za-z]{3,9})[\s\-/.,]*(\d{2,4})$/);
  if (m) {
    const d = Number(m[1]);
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
    let y = Number(m[3]);
    if (y < 100) y += 2000;
    return mo && isRealDate(y, mo, d) ? `${y}-${pad(mo)}-${pad(d)}` : '';
  }

  return '';
}

// One clock time -> "HH:MM" 24h, or ''. Handles Excel time fractions
// (0.4166 = 10:00), "10:00", "10.00", "10 AM", "1:30 pm". Second return
// value says whether the text itself carried an am/pm marker, which the
// range parser needs to disambiguate "2:00 - 5:00 PM".
function parseOneTime(raw: unknown): { hhmm: string; hadMeridiem: boolean; pm: boolean } | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') {
    if (raw < 0 || raw >= 1) return null;
    const total = Math.round(raw * 1440);
    return { hhmm: `${pad(Math.floor(total / 60) % 24)}:${pad(total % 60)}`, hadMeridiem: false, pm: false };
  }
  const m = String(raw).trim().toLowerCase().match(/^(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (min > 59) return null;
  const mer = m[3]?.replace(/\./g, '');
  if (mer === 'pm' && h < 12) h += 12;
  if (mer === 'am' && h === 12) h = 0;
  if (h > 23) return null;
  return { hhmm: `${pad(h)}:${pad(min)}`, hadMeridiem: !!mer, pm: mer === 'pm' };
}

export function parseSingleTime(raw: unknown): string {
  return parseOneTime(raw)?.hhmm ?? '';
}

// "10:00 AM - 1:00 PM", "10:00-13:00", "10 to 1 pm", "2:00 - 5:00 PM".
// A range with no am/pm on the start but "pm" on the end ("2:00 - 5:00 PM")
// means the start is PM too, unless that would put the start AFTER the end
// ("10:00 - 1:00 PM" is 10 AM - 1 PM).
export function parseTimeRange(raw: unknown): { start: string; end: string } {
  if (raw === null || raw === undefined || raw === '') return { start: '', end: '' };
  if (typeof raw === 'number') return { start: parseSingleTime(raw), end: '' };

  const parts = String(raw).trim().split(/\s*(?:-|–|—|\bto\b)\s*/i).filter(Boolean);
  if (parts.length === 1) return { start: parseSingleTime(parts[0]), end: '' };
  if (parts.length !== 2) return { start: '', end: '' };

  const a = parseOneTime(parts[0]);
  const b = parseOneTime(parts[1]);
  if (!a || !b) return { start: a?.hhmm ?? '', end: b?.hhmm ?? '' };

  let start = a.hhmm;
  if (!a.hadMeridiem && b.hadMeridiem && b.pm) {
    const [sh, sm] = start.split(':').map(Number);
    const [eh] = b.hhmm.split(':').map(Number);
    if (sh < 12 && sh + 12 < eh) start = `${pad(sh + 12)}:${pad(sm)}`;
  }
  return { start, end: b.hhmm };
}

// ---- Spreadsheet header matching ------------------------------------------

const norm = (h: unknown) => String(h ?? '').toLowerCase().replace(/[\s._/()\-:]/g, '');

type ColumnMap = { date: number; time: number; start: number; end: number; code: number; name: number; venue: number };

function findCol(headers: string[], exact: string[], includes: string[], skip: number[] = []): number {
  const byExact = headers.findIndex((h, i) => !skip.includes(i) && exact.includes(h));
  if (byExact !== -1) return byExact;
  return headers.findIndex((h, i) => !skip.includes(i) && h !== '' && includes.some((k) => h.includes(k)));
}

export function mapHeaders(headerRow: unknown[]): ColumnMap | null {
  const headers = Array.from({ length: headerRow.length }, (_, i) => norm(headerRow[i]));
  const date = findCol(headers, ['date', 'examdate', 'dateofexam'], ['date']);
  if (date === -1) return null;

  const start = findCol(headers, ['start', 'from', 'starttime', 'begin'], ['starttime', 'fromtime']);
  const end = findCol(headers, ['end', 'endtime', 'finish'], ['endtime', 'totime']);
  const time = findCol(headers, ['time', 'timing', 'timings', 'slot', 'session'], ['time', 'slot', 'session'], [start, end]);

  const code = findCol(headers, ['code', 'subjectcode', 'coursecode', 'papercode'], ['code']);
  const name = findCol(headers, ['subject', 'subjectname', 'coursename', 'course', 'paper', 'title'], ['subjectname', 'coursename', 'subject', 'course', 'paper'], [code]);
  const venue = findCol(headers, ['venue', 'room', 'hall', 'location'], ['venue', 'room', 'hall', 'location']);

  if (code === -1 && name === -1) return null;
  if (time === -1 && start === -1) return null;
  return { date, time, start, end, code, name, venue };
}

export type ParsedSheet = {
  entries: ExamEntry[];
  // Rows that had *something* in them but couldn't be turned into a clean
  // entry — kept (with blanks) so the preview shows them for fixing rather
  // than silently dropping a real exam.
  problemRows: number[]; // 1-based indexes into `entries`
};

export function parseExamRows(rows: unknown[][]): ParsedSheet | { error: string } {
  let headerIdx = -1;
  let map: ColumnMap | null = null;
  for (let i = 0; i < Math.min(rows.length, 12); i++) {
    const candidate = mapHeaders(rows[i] ?? []);
    if (candidate) {
      headerIdx = i;
      map = candidate;
      break;
    }
  }
  if (!map) {
    return {
      error:
        "Couldn't find the columns. The sheet needs a Date column, a Subject Code and/or Subject Name column, and a Time column (or Start Time + End Time) in its first 12 rows. Use \"Download template\" for the exact layout.",
    };
  }

  const entries: ExamEntry[] = [];
  const problemRows: number[] = [];
  let lastDate = '';

  for (const row of rows.slice(headerIdx + 1)) {
    if (!row || row.every((c) => c === undefined || c === null || String(c).trim() === '')) continue;
    const cell = (i: number) => (i === -1 ? '' : row[i]);

    const code = String(cell(map.code) ?? '').trim().toUpperCase();
    const name = String(cell(map.name) ?? '').trim();
    if (!code && !name) continue; // a spacer/notes row with no subject isn't an exam

    // A subject with NO date and NO time at all isn't scheduled — e.g. a
    // row of the portal's template (which lists every subject of the
    // semester) that has no exam this time. Skip it instead of carrying
    // the previous row's date down onto it.
    const blank = (i: number) => i === -1 || cell(i) === undefined || cell(i) === null || String(cell(i)).trim() === '';
    if (blank(map.date) && blank(map.start) && blank(map.end) && blank(map.time)) continue;

    // Merged date cells (one date spanning two subjects in the same day)
    // come through as blank on the second row — carry the last date down.
    let date = parseExamDate(cell(map.date));
    if (!date && (cell(map.date) === '' || cell(map.date) === undefined) && lastDate) date = lastDate;
    if (date) lastDate = date;

    let start = '';
    let end = '';
    if (map.start !== -1) {
      start = parseSingleTime(cell(map.start));
      end = parseSingleTime(cell(map.end));
    } else {
      const range = parseTimeRange(cell(map.time));
      start = range.start;
      end = range.end;
    }

    entries.push({ date, startTime: start, endTime: end, subjectCode: code, subjectName: name, venue: String(cell(map.venue) ?? '').trim() });
    if (!date || !start) problemRows.push(entries.length);
  }

  if (entries.length === 0) return { error: 'The header row was found, but there were no exam rows under it.' };
  return { entries, problemRows };
}

// ---- Whole-college sheet (Branch + Semester + Exam Type per row) --------

const EXAM_TYPE_BY_NORM = new Map<string, ExamTypeId>();
for (const t of EXAM_TYPES) {
  EXAM_TYPE_BY_NORM.set(norm(t.id), t.id);
  EXAM_TYPE_BY_NORM.set(norm(t.label), t.id);
}
// A few extra spellings people actually type, beyond the exact id/label —
// kept separate from the loop above so the canonical id/label always wins
// if there's ever a clash.
EXAM_TYPE_BY_NORM.set(norm('midsem'), 'midsem');
EXAM_TYPE_BY_NORM.set(norm('mid sem'), 'midsem');
EXAM_TYPE_BY_NORM.set(norm('midsem repeater'), 'midsem-repeaters');
EXAM_TYPE_BY_NORM.set(norm('midsem repeaters'), 'midsem-repeaters');
EXAM_TYPE_BY_NORM.set(norm('mid sem repeaters'), 'midsem-repeaters');
EXAM_TYPE_BY_NORM.set(norm('endsem'), 'endsem');
EXAM_TYPE_BY_NORM.set(norm('end sem'), 'endsem');
EXAM_TYPE_BY_NORM.set(norm('endsem repeater'), 'endsem-repeaters');
EXAM_TYPE_BY_NORM.set(norm('endsem repeaters'), 'endsem-repeaters');
EXAM_TYPE_BY_NORM.set(norm('end sem repeaters'), 'endsem-repeaters');
EXAM_TYPE_BY_NORM.set(norm('supplementary'), 'supplementary');
EXAM_TYPE_BY_NORM.set(norm('supply'), 'supplementary');
EXAM_TYPE_BY_NORM.set(norm('reexam'), 'supplementary');
EXAM_TYPE_BY_NORM.set(norm('re exam'), 'supplementary');
EXAM_TYPE_BY_NORM.set(norm('quiz'), 'quiz');
EXAM_TYPE_BY_NORM.set(norm('internal'), 'quiz');

function matchExamType(raw: string): ExamTypeId | null {
  return EXAM_TYPE_BY_NORM.get(norm(raw)) ?? null;
}

function examTypeLabelFor(id: ExamTypeId): string {
  return EXAM_TYPES.find((t) => t.id === id)?.label ?? id;
}

// One sheet, every branch/semester/exam-type mixed together — the
// no-AI equivalent of uploading the whole college's PDF at once.
// Repeaters and supplementary exams routinely run on a totally
// different week than the main exam they belong to; nothing here
// assumes otherwise — each row's OWN Exam Type and dates are all that
// matter, there's no shared-week constraint to violate.
//
// Reuses the exact same per-row date/time/code/name/venue detection as
// parseExamRows above (same findCol/norm helpers), just with three
// more required columns to say which class a row belongs to.
export function parseWholeCollegeExamRows(
  rows: unknown[][],
): { groups: ExamGroup[]; warnings: string[] } | { error: string } {
  let headerIdx = -1;
  let map: ColumnMap | null = null;
  let branchCol = -1;
  let semesterCol = -1;
  let examTypeCol = -1;

  for (let i = 0; i < Math.min(rows.length, 12); i++) {
    const headerRow = rows[i] ?? [];
    const candidate = mapHeaders(headerRow);
    if (!candidate) continue;
    const headers = Array.from({ length: headerRow.length }, (_, j) => norm(headerRow[j]));
    const b = findCol(headers, ['branch', 'dept', 'department'], ['branch', 'dept']);
    const s = findCol(headers, ['semester', 'sem'], ['semester', 'sem']);
    const e = findCol(headers, ['examtype', 'exam', 'type'], ['examtype', 'exam']);
    if (b === -1 || s === -1 || e === -1) continue; // found a date-sheet-shaped header, but not this whole-college one
    headerIdx = i;
    map = candidate;
    branchCol = b;
    semesterCol = s;
    examTypeCol = e;
    break;
  }

  if (!map) {
    return {
      error:
        "Couldn't find the columns. This sheet needs Branch, Semester and Exam Type columns in addition to Date, Subject and Time — use \"Download template\" for the exact layout. For a single class's date sheet, use the other upload above instead.",
    };
  }

  const groups = new Map<string, ExamGroup>();
  const warnings: string[] = [];
  let lastDate = '';
  let lastBranch = '';
  let lastSemester = '';
  let lastExamType = '';
  let rowNum = headerIdx + 1;

  for (const row of rows.slice(headerIdx + 1)) {
    rowNum++;
    if (!row || row.every((c) => c === undefined || c === null || String(c).trim() === '')) continue;
    const cell = (i: number) => (i === -1 ? '' : row[i]);

    const code = String(cell(map.code) ?? '').trim().toUpperCase();
    const name = String(cell(map.name) ?? '').trim();
    if (!code && !name) continue;

    // Merged cells (one class/date spanning several subject rows) come
    // through blank on the later rows — carry the last real value down,
    // same idea as parseExamRows' date-carrying above.
    let branchRaw = String(cell(branchCol) ?? '').trim();
    if (!branchRaw && lastBranch) branchRaw = lastBranch;
    if (branchRaw) lastBranch = branchRaw;
    const branch = branchRaw.toUpperCase();

    let semRaw = String(cell(semesterCol) ?? '').trim();
    if (!semRaw && lastSemester) semRaw = lastSemester;
    if (semRaw) lastSemester = semRaw;
    const semester = parseInt(semRaw, 10);

    let examTypeRaw = String(cell(examTypeCol) ?? '').trim();
    if (!examTypeRaw && lastExamType) examTypeRaw = lastExamType;
    if (examTypeRaw) lastExamType = examTypeRaw;
    const examType = matchExamType(examTypeRaw);

    let date = parseExamDate(cell(map.date));
    if (!date && (cell(map.date) === '' || cell(map.date) === undefined) && lastDate) date = lastDate;
    if (date) lastDate = date;

    let start = '';
    let end = '';
    if (map.start !== -1) {
      start = parseSingleTime(cell(map.start));
      end = parseSingleTime(cell(map.end));
    } else {
      const range = parseTimeRange(cell(map.time));
      start = range.start;
      end = range.end;
    }

    if (!['CSE', 'ECE', 'MNC'].includes(branch)) {
      warnings.push(`Row ${rowNum}: "${branchRaw}" isn't CSE, ECE or MNC — skipped (${name || code}).`);
      continue;
    }
    if (!Number.isInteger(semester) || semester < 1 || semester > 8) {
      warnings.push(`Row ${rowNum}: "${semRaw}" isn't a valid semester (1-8) — skipped (${name || code}).`);
      continue;
    }
    if (!examType) {
      warnings.push(`Row ${rowNum}: "${examTypeRaw}" isn't a recognized exam type — skipped (${name || code}).`);
      continue;
    }

    const key = examDocId(branch, semester, examType);
    let group = groups.get(key);
    if (!group) {
      group = { branch, semester, examType, examTypeLabel: examTypeLabelFor(examType), entries: [] };
      groups.set(key, group);
    }
    group.entries.push({ date, startTime: start, endTime: end, subjectCode: code, subjectName: name, venue: String(cell(map.venue) ?? '').trim() });
    if (!date || !start) warnings.push(`Row ${rowNum}: missing a date or time (${name || code}) — check it in the review table.`);
  }

  if (groups.size === 0) {
    return { error: 'The header row was found, but no row had a recognized Branch, Semester, Exam Type and Subject together.' };
  }
  return { groups: Array.from(groups.values()), warnings };
}

export const WHOLE_COLLEGE_TEMPLATE_CSV =
  'Branch,Semester,Exam Type,Date,Start Time,End Time,Subject Code,Subject Name,Venue\n' +
  'CSE,3,Midsem,21/09/2026,09:00,10:00,CS301,Computer Organization and Architecture,\n' +
  'ECE,3,Midsem,21/09/2026,09:00,10:00,CS301,Computer Organization and Architecture,\n' +
  'CSE,3,Midsem Repeaters,05/10/2026,09:00,10:00,CS301,Operating System,\n';

export function validateEntries(entries: ExamEntry[]): string | null {
  if (entries.length === 0) return 'Add at least one exam.';
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const label = `Row ${i + 1}`;
    if (!e.subjectCode.trim() && !e.subjectName.trim()) return `${label}: needs a subject code or name.`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date)) return `${label}: pick a valid date.`;
    if (!/^\d{2}:\d{2}$/.test(e.startTime)) return `${label}: set a start time.`;
    if (e.endTime && !/^\d{2}:\d{2}$/.test(e.endTime)) return `${label}: end time isn't valid.`;
    if (e.endTime && e.endTime <= e.startTime) return `${label}: end time must be after the start time.`;
  }
  return null;
}

export function sortEntries(entries: ExamEntry[]): ExamEntry[] {
  return [...entries].sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));
}

export const TEMPLATE_CSV =
  'Date,Start Time,End Time,Subject Code,Subject Name,Venue\n' +
  '12/11/2026,10:00,13:00,CS201,Data Structures,Room 101\n' +
  '13/11/2026,10:00,13:00,MA201,Discrete Mathematics,Room 102\n';
