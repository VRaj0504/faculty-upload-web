import * as XLSX from 'xlsx';
import * as pdfjsLib from 'pdfjs-dist';

// pdf.js needs its worker script available at runtime. The npm package
// ships it pre-built; importing it as a URL and pointing workerSrc at
// that URL is the standard Vite-friendly way to wire this up without a
// separate manual copy-to-public-folder build step.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- Vite's ?url suffix has no type declaration, but is real.
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export type TimetableSlot = {
  id: string;
  startTime: string;
  endTime: string;
  subjectCode: string;
  subjectName: string;
  faculty: string;
  room: string;
  group?: string;
};

export type TimetableDay = {
  day: string;
  slots: TimetableSlot[];
};

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

const DAY_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: 'Monday', pattern: /^mo(n(day)?)?$/i },
  { label: 'Tuesday', pattern: /^tu(e(s(day)?)?)?$/i },
  { label: 'Wednesday', pattern: /^we(d(nesday)?)?$/i },
  { label: 'Thursday', pattern: /^th(u(r(s(day)?)?)?)?$/i },
  { label: 'Friday', pattern: /^fr(i(day)?)?$/i },
  { label: 'Saturday', pattern: /^sa(t(urday)?)?$/i },
  { label: 'Sunday', pattern: /^su(n(day)?)?$/i },
];

function normalizeDayLabel(raw: string): string | null {
  const trimmed = raw.trim();
  const match = DAY_PATTERNS.find((d) => d.pattern.test(trimmed));
  return match ? match.label : null;
}

// A single time value out of a spreadsheet cell can arrive in wildly
// different shapes depending on how the sheet was authored: "9:00",
// "09:00 AM", or (because Excel silently reformats time-looking text
// into its own serial date number) a raw float like 0.375 for 9:00 AM.
// This normalizes all three into a plain "H:MM" 24-hour string, which is
// what timetableService.ts / TimetableScreen.tsx expect everywhere else.
function normalizeTimeCell(raw: string | number): string {
  if (typeof raw === 'number') {
    // Excel time serials are a fraction of a 24-hour day.
    const totalMinutes = Math.round(raw * 24 * 60);
    const h = Math.floor(totalMinutes / 60) % 24;
    const m = totalMinutes % 60;
    return `${h}:${String(m).padStart(2, '0')}`;
  }
  const text = raw.trim();
  const match = text.match(/(\d{1,2}):?(\d{2})?\s*(AM|PM)?/i);
  if (!match) return text; // unrecognized shape — pass through, caller reviews it
  let h = parseInt(match[1], 10);
  const m = match[2] ?? '00';
  if (match[3]) {
    const isPM = /pm/i.test(match[3]);
    if (isPM && h !== 12) h += 12;
    if (!isPM && h === 12) h = 0;
  }
  return `${h}:${m}`;
}

// Header synonyms this accepts, matched case-insensitively against the
// sheet's first row. Add more synonyms here if a real department sheet
// uses different wording than what's covered — safer than trying to
// guess every possible phrasing up front.
const HEADER_SYNONYMS: Record<keyof Omit<TimetableSlot, 'id'>, string[]> = {
  startTime: ['start time', 'start', 'from', 'time from'],
  endTime: ['end time', 'end', 'to', 'time to'],
  subjectCode: ['subject code', 'code', 'course code'],
  subjectName: ['subject name', 'subject', 'course', 'course name'],
  faculty: ['faculty', 'teacher', 'instructor', 'professor'],
  room: ['room', 'venue', 'location', 'hall'],
  group: ['group', 'batch'],
};
const DAY_HEADER_SYNONYMS = ['day', 'weekday'];

function findColumn(headerRow: string[], synonyms: string[]): number {
  // headerRow can be a sparse array with real gaps at blank cells (a
  // spacer column, for instance) — .map() at the call site silently
  // skips those gaps, but .findIndex() below does not: it visits every
  // index including gaps and hands the gap through as undefined, which
  // would crash calling .trim() on it. Filling every index explicitly
  // closes the gaps first.
  const filled = Array.from({ length: headerRow.length }, (_, i) => headerRow[i] ?? '');
  return filled.findIndex((h) => synonyms.includes(h.trim().toLowerCase()));
}

export type SpreadsheetParseResult = {
  days: TimetableDay[];
  // Rows that had a recognizable day but no recognizable time, or vice
  // versa — skipped rather than guessed at, since a half-parsed row is
  // more dangerous than a visibly missing one (it looks complete but
  // shows the wrong thing). Reported back so the uploader can go fix
  // the raw sheet and re-import, rather than silently losing rows.
  skippedRowCount: number;
};

// Fully deterministic — no OCR, no guessing beyond the header-synonym
// matching above. Works for .xlsx, .xls, and .csv, since SheetJS reads
// all three through the same API. Expects one row per class slot, with
// a Day column plus Start/End time columns; every other column is
// optional and left blank if the sheet doesn't have it.
export async function parseSpreadsheetFile(file: File): Promise<SpreadsheetParseResult> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array', cellDates: false });
  const firstSheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[firstSheetName];
  const rows: (string | number)[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });

  if (rows.length < 2) {
    throw new Error('This sheet has no data rows below the header.');
  }

  const headerRow = rows[0].map((h) => String(h));
  const dayCol = findColumn(headerRow, DAY_HEADER_SYNONYMS);
  const startCol = findColumn(headerRow, HEADER_SYNONYMS.startTime);
  const endCol = findColumn(headerRow, HEADER_SYNONYMS.endTime);
  if (dayCol === -1 || startCol === -1 || endCol === -1) {
    throw new Error(
      'Could not find Day, Start Time, and End Time columns in the header row. Check the column names match (Day / Start Time / End Time, or a close synonym).',
    );
  }
  const codeCol = findColumn(headerRow, HEADER_SYNONYMS.subjectCode);
  const nameCol = findColumn(headerRow, HEADER_SYNONYMS.subjectName);
  const facultyCol = findColumn(headerRow, HEADER_SYNONYMS.faculty);
  const roomCol = findColumn(headerRow, HEADER_SYNONYMS.room);
  const groupCol = findColumn(headerRow, HEADER_SYNONYMS.group);

  const byDay = new Map<string, TimetableSlot[]>(WEEKDAYS.map((d) => [d, []]));
  let skippedRowCount = 0;

  for (const row of rows.slice(1)) {
    if (row.every((cell) => String(cell).trim() === '')) continue; // blank spacer row

    const dayLabel = normalizeDayLabel(String(row[dayCol] ?? ''));
    const startRaw = row[startCol];
    const endRaw = row[endCol];
    if (!dayLabel || startRaw === '' || endRaw === '') {
      skippedRowCount++;
      continue;
    }

    const slot: TimetableSlot = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      startTime: normalizeTimeCell(startRaw),
      endTime: normalizeTimeCell(endRaw),
      subjectCode: codeCol !== -1 ? String(row[codeCol] ?? '').trim() : '',
      subjectName: nameCol !== -1 ? String(row[nameCol] ?? '').trim() : '',
      faculty: facultyCol !== -1 ? String(row[facultyCol] ?? '').trim() : '',
      room: roomCol !== -1 ? String(row[roomCol] ?? '').trim() : '',
      ...(groupCol !== -1 && String(row[groupCol] ?? '').trim()
        ? { group: String(row[groupCol]).trim() }
        : {}),
    };
    byDay.get(dayLabel)!.push(slot);
  }

  const days: TimetableDay[] = WEEKDAYS.map((day) => ({ day, slots: byDay.get(day)! }));
  return { days, skippedRowCount };
}

// Renders a PDF's first page to a JPEG Blob, so a PDF can be fed through
// the exact same extractTimetableInfo Vision-OCR Cloud Function that
// already handles photo imports — no separate PDF-parsing pipeline to
// build and no separate reliability story to reason about. For a
// multi-page "whole college" PDF (one page per section), see
// renderAllPdfPagesToJpegBlobs below instead.
export async function renderPdfFirstPageToJpegBlob(file: File): Promise<Blob> {
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  const page = await pdf.getPage(1);
  // Scale 2x for OCR legibility — a PDF rendered at its native "CSS
  // pixel" viewport is often too low-resolution for Vision to read small
  // timetable cell text reliably, the same reason a low-res phone photo
  // OCRs worse than a clear one.
  const viewport = page.getViewport({ scale: 2 });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not create a canvas to render the PDF page.');
  await page.render({ canvasContext: context, viewport, canvas }).promise;

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Could not convert the rendered PDF page to an image.'))),
      'image/jpeg',
      0.92,
    );
  });
}

// Renders EVERY page of a PDF to a JPEG Blob — for a "whole college"
// timetable PDF where one page = one section's schedule. Each page still
// gets OCR'd separately through extractTimetableInfo (same as the
// single-page path); this only handles the rendering side. Kept separate
// from renderPdfFirstPageToJpegBlob rather than adding a "how many pages"
// parameter to it, since the two call sites (single scan import vs. bulk
// import) have different UI flows around them.
export async function renderAllPdfPagesToJpegBlobs(file: File): Promise<Blob[]> {
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  const blobs: Blob[] = [];
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error(`Could not create a canvas to render page ${pageNum}.`);
    await page.render({ canvasContext: context, viewport, canvas }).promise;
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error(`Could not convert page ${pageNum} to an image.`))),
        'image/jpeg',
        0.92,
      );
    });
    blobs.push(blob);
  }
  return blobs;
}

// Best-effort extraction of "SEMESTER <n> <BRANCH> [<SECTION>]" from a
// page's OCR'd text — every page in a real "whole college" timetable
// export has this as its title (see the sample PDF this was built
// against), and Vision OCR reads title text along with the grid, so this
// needs no extra API call, just a regex over rawText that
// extractTimetableInfo already returns. Deliberately conservative: only
// recognizes the three branches this app actually models (CSE/ECE/MNC).
// A M.Tech page, or any page whose title doesn't match, returns null —
// left for the reviewer to fill in by hand rather than guessed at, since
// a wrong auto-fill here would silently save a section's real timetable
// under the wrong class.
export function detectSectionFromHeaderText(
  rawText: string,
): { branch: string; semester: number; section: string } | null {
  const match = rawText.match(/SEMESTER\s+(\d+)\s+(CSE|ECE|MNC)\s*([A-Z])?\b/i);
  if (!match) return null;
  return {
    semester: parseInt(match[1], 10),
    branch: match[2].toUpperCase(),
    section: match[3] ? match[3].toUpperCase() : '',
  };
}

export type MultiSectionGroup = {
  branch: string;
  semester: number;
  section: string;
  days: TimetableDay[];
};

export type MultiSectionParseResult = {
  groups: MultiSectionGroup[];
  skippedRowCount: number;
};

const SECTION_HEADER_SYNONYMS = {
  branch: ['branch', 'dept', 'department'],
  semester: ['semester', 'sem'],
  section: ['section', 'sec'],
};

// Same deterministic parsing as parseSpreadsheetFile, but for a single
// sheet covering EVERY section at once — expects three extra columns
// (Branch, Semester, Section) on every row, and groups rows by that
// triple into one TimetableDay[] set per section. This is the fully
// automatic path (no OCR, no per-page review needed): if your timetable
// software can export one big sheet like this instead of a PDF, use
// this over the PDF batch import every time.
export async function parseSpreadsheetAllSections(file: File): Promise<MultiSectionParseResult> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array', cellDates: false });
  const firstSheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[firstSheetName];
  const rows: (string | number)[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });

  if (rows.length < 2) {
    throw new Error('This sheet has no data rows below the header.');
  }

  const headerRow = rows[0].map((h) => String(h));
  const dayCol = findColumn(headerRow, DAY_HEADER_SYNONYMS);
  const startCol = findColumn(headerRow, HEADER_SYNONYMS.startTime);
  const endCol = findColumn(headerRow, HEADER_SYNONYMS.endTime);
  const branchCol = findColumn(headerRow, SECTION_HEADER_SYNONYMS.branch);
  const semesterCol = findColumn(headerRow, SECTION_HEADER_SYNONYMS.semester);
  const sectionCol = findColumn(headerRow, SECTION_HEADER_SYNONYMS.section);
  if (dayCol === -1 || startCol === -1 || endCol === -1) {
    throw new Error(
      'Could not find Day, Start Time, and End Time columns in the header row.',
    );
  }
  if (branchCol === -1 || semesterCol === -1) {
    throw new Error(
      'A whole-college sheet needs Branch and Semester columns on every row (Section too, unless a semester has only one section) — this sheet is missing one or both. Use the single-section import instead if this file only covers one class.',
    );
  }
  const codeCol = findColumn(headerRow, HEADER_SYNONYMS.subjectCode);
  const nameCol = findColumn(headerRow, HEADER_SYNONYMS.subjectName);
  const facultyCol = findColumn(headerRow, HEADER_SYNONYMS.faculty);
  const roomCol = findColumn(headerRow, HEADER_SYNONYMS.room);
  const groupCol = findColumn(headerRow, HEADER_SYNONYMS.group);

  const byGroup = new Map<string, MultiSectionGroup>();
  let skippedRowCount = 0;

  for (const row of rows.slice(1)) {
    if (row.every((cell) => String(cell).trim() === '')) continue;

    const dayLabel = normalizeDayLabel(String(row[dayCol] ?? ''));
    const startRaw = row[startCol];
    const endRaw = row[endCol];
    const branch = String(row[branchCol] ?? '').trim().toUpperCase();
    const semesterRaw = String(row[semesterCol] ?? '').trim();
    const semester = parseInt(semesterRaw, 10);
    const section = sectionCol !== -1 ? String(row[sectionCol] ?? '').trim().toUpperCase() : '';

    if (!dayLabel || startRaw === '' || endRaw === '' || !branch || !semesterRaw || Number.isNaN(semester)) {
      skippedRowCount++;
      continue;
    }

    const groupKey = `${branch}-${semester}-${section}`;
    if (!byGroup.has(groupKey)) {
      byGroup.set(groupKey, {
        branch,
        semester,
        section,
        days: WEEKDAYS.map((day) => ({ day, slots: [] })),
      });
    }
    const group = byGroup.get(groupKey)!;
    const dayEntry = group.days.find((d) => d.day === dayLabel)!;
    dayEntry.slots.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      startTime: normalizeTimeCell(startRaw),
      endTime: normalizeTimeCell(endRaw),
      subjectCode: codeCol !== -1 ? String(row[codeCol] ?? '').trim() : '',
      subjectName: nameCol !== -1 ? String(row[nameCol] ?? '').trim() : '',
      faculty: facultyCol !== -1 ? String(row[facultyCol] ?? '').trim() : '',
      room: roomCol !== -1 ? String(row[roomCol] ?? '').trim() : '',
      ...(groupCol !== -1 && String(row[groupCol] ?? '').trim()
        ? { group: String(row[groupCol]).trim() }
        : {}),
    });
  }

  return { groups: Array.from(byGroup.values()), skippedRowCount };
}

// Parses a "PDF converted to Excel" style workbook — one sheet per
// section, sheet name itself is the section title ("SEMESTER 1 ECE A"),
// row 1 is "Day" + 9 time-range column headers, each subsequent row is
// one day with each cell holding that slot's text (possibly multi-line:
// subject code on its own line, room+faculty combined on the next).
// A day with two groups sharing the same time slot (a lab split into
// Group 1 / Group 2) appears as TWO rows: the first with the day name
// and Group 1's cells, the second with a blank day cell (meaning "same
// day as above") and Group 2's cells in the same columns — this reads
// that "blank day = continuation of the previous day" convention
// directly rather than needing to split text within one cell.
//
// Deliberately does not try to split a cell's second line into
// separate room/faculty fields — "CR 6 PAS F1" is genuinely ambiguous
// (is "F1" faculty or part of the room code?) without knowing this
// sheet's exact convention, and a wrong split is worse than an unsplit
// line a reviewer can see whole and fix themselves.
function to24Hour(hour12: number, meridiem: string): number {
  const h = hour12 % 12;
  return /pm/i.test(meridiem) ? h + 12 : h;
}

// A header like "01:00 - 02:00 PM" only states the meridiem once, on
// the end time — the start is genuinely ambiguous between 1 AM and
// 1 PM from its text alone. Rather than treat "no explicit meridiem"
// as "don't adjust" (which silently produces 1:00 instead of the
// correct 13:00 for every such afternoon column), this tries both AM
// and PM for whichever side lacks one and keeps whichever keeps the
// range moving forward in time by a plausible single-class-slot gap
// (0–4 hours) — true for every real class slot, never true for the
// wrong meridiem on a well-formed range.
function parseHeaderTimeRange(text: string): { startTime: string; endTime: string } | null {
  const match = text.match(
    /(\d{1,2}):?(\d{0,2})\s*(AM|PM)?\s*[-–—]?\s*(\d{1,2}):?(\d{0,2})\s*(AM|PM)?/i,
  );
  if (!match) return null;
  const [, h1raw, m1raw, mer1, h2raw, m2raw, mer2] = match;
  const h1 = parseInt(h1raw, 10);
  const h2 = parseInt(h2raw, 10);
  const m1 = m1raw || '00';
  const m2 = m2raw || '00';

  let startHour: number;
  let endHour: number;
  if (mer1 && mer2) {
    startHour = to24Hour(h1, mer1);
    endHour = to24Hour(h2, mer2);
  } else if (mer2 && !mer1) {
    const endHour0 = to24Hour(h2, mer2);
    const tryAM = to24Hour(h1, 'AM');
    const tryPM = to24Hour(h1, 'PM');
    const diffAM = endHour0 - tryAM;
    startHour = diffAM > 0 && diffAM <= 4 ? tryAM : tryPM;
    endHour = endHour0;
  } else if (mer1 && !mer2) {
    const startHour0 = to24Hour(h1, mer1);
    const tryAM = to24Hour(h2, 'AM');
    const tryPM = to24Hour(h2, 'PM');
    const diffAM = tryAM - startHour0;
    endHour = diffAM > 0 && diffAM <= 4 ? tryAM : tryPM;
    startHour = startHour0;
  } else {
    // Neither side has an explicit meridiem at all — nothing to
    // disambiguate with, so take the digits as given (correct for a
    // sheet where every column is naturally AM already).
    startHour = h1;
    endHour = h2;
  }

  return {
    startTime: `${startHour}:${m1}`,
    endTime: `${endHour}:${m2}`,
  };
}

// Cheap check for whether a workbook is this grid format at all, so the
// caller can try this parser first and fall back to the flat
// one-row-per-class parser (parseSpreadsheetAllSections) if not — rather
// than requiring the uploader to know in advance which shape their file
// is and pick the right button.
export function looksLikeGridWorkbook(workbook: any): boolean {
  return workbook.SheetNames.some((name: string) => detectSectionFromHeaderText(name) !== null);
}

export async function parseGridWorkbookAllSections(workbook: any): Promise<MultiSectionParseResult> {
  const groups: MultiSectionGroup[] = [];
  let skippedRowCount = 0;

  for (const sheetName of workbook.SheetNames) {
    const detected = detectSectionFromHeaderText(sheetName);
    if (!detected) continue; // "Index", M.Tech sheets, or anything unrecognized — skipped, not an error

    const sheet = workbook.Sheets[sheetName];
    const rows: (string | null)[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: null });

    const headerRowIndex = rows.findIndex((r) => String(r[0] ?? '').trim().toLowerCase() === 'day');
    if (headerRowIndex === -1) {
      skippedRowCount++;
      continue;
    }
    const headerRow = rows[headerRowIndex];

    const timeColumns: { colIndex: number; startTime: string; endTime: string }[] = [];
    for (let col = 1; col < headerRow.length; col++) {
      const parsed = parseHeaderTimeRange(String(headerRow[col] ?? ''));
      if (parsed) timeColumns.push({ colIndex: col, ...parsed });
    }
    if (timeColumns.length === 0) {
      skippedRowCount++;
      continue;
    }

    const days: TimetableDay[] = WEEKDAYS.map((day) => ({ day, slots: [] }));
    let currentDay: string | null = null;

    for (let r = headerRowIndex + 1; r < rows.length; r++) {
      const row = rows[r];
      const dayCellRaw = String(row[0] ?? '').trim();
      const dayLabel = dayCellRaw ? normalizeDayLabel(dayCellRaw) : null;
      if (dayLabel) currentDay = dayLabel;
      if (!currentDay) continue; // stray row before any day is established (e.g. trailing footer text)

      for (const tc of timeColumns) {
        const cellRaw = row[tc.colIndex];
        if (!cellRaw) continue;
        const cellText = String(cellRaw).trim();
        if (!cellText) continue;

        const lines = cellText.split('\n').map((l) => l.trim()).filter(Boolean);
        let group: string | undefined;
        let contentLines = lines;
        if (lines[0] && /^group\s*\d+$/i.test(lines[0])) {
          group = lines[0];
          contentLines = lines.slice(1);
        }
        if (contentLines.length === 0) continue;

        const dayEntry = days.find((d) => d.day === currentDay)!;
        dayEntry.slots.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          startTime: tc.startTime,
          endTime: tc.endTime,
          subjectCode: contentLines[0],
          subjectName: '',
          faculty: '',
          room: contentLines.slice(1).join(' '),
          ...(group ? { group } : {}),
        });
      }
    }

    groups.push({ branch: detected.branch, semester: detected.semester, section: detected.section, days });
  }

  return { groups, skippedRowCount };
}

// Single entry point for the "whole college" Excel/CSV import — reads
// the file once, checks whether it's the grid format (one sheet per
// section, sheet name is the section title) or the flat format (one row
// per class, with Branch/Semester/Section columns), and parses with
// whichever one actually matches. The uploader shouldn't need to know
// in advance which shape their own spreadsheet is.
export async function parseAnySpreadsheetAllSections(file: File): Promise<MultiSectionParseResult> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array', cellDates: false });
  if (looksLikeGridWorkbook(workbook)) {
    return parseGridWorkbookAllSections(workbook);
  }
  return parseSpreadsheetAllSections(file);
}
