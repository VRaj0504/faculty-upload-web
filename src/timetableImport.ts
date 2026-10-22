

async function getXLSX() {
  return await import('xlsx');
}

let pdfWorkerConfigured = false;
export async function getPdfjs() {
  const pdfjsLib = await import('pdfjs-dist');
  if (!pdfWorkerConfigured) {

    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore -- Vite's ?url suffix has no type declaration, but is real.
    const { default: pdfWorkerUrl } = await import('pdfjs-dist/build/pdf.worker.mjs?url');
    pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
    pdfWorkerConfigured = true;
  }
  return pdfjsLib;
}

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

function normalizeTimeCell(raw: string | number): string {
  if (typeof raw === 'number') {

    const totalMinutes = Math.round(raw * 24 * 60);
    const h = Math.floor(totalMinutes / 60) % 24;
    const m = totalMinutes % 60;
    return `${h}:${String(m).padStart(2, '0')}`;
  }
  const text = raw.trim();
  const match = text.match(/(\d{1,2}):?(\d{2})?\s*(AM|PM)?/i);
  if (!match) return text;
  let h = parseInt(match[1], 10);
  const m = match[2] ?? '00';
  if (match[3]) {
    const isPM = /pm/i.test(match[3]);
    if (isPM && h !== 12) h += 12;
    if (!isPM && h === 12) h = 0;
  } else if (h >= 1 && h <= 7) {

    h += 12;
  }
  return `${h}:${m}`;
}

export const WHOLE_COLLEGE_TIMETABLE_TEMPLATE_CSV =
  'Branch,Semester,Section,Day,Start Time,End Time,Subject Code,Subject Name,Faculty,Room,Group\n' +
  'ECE,1,A,Monday,09:00,10:00,AS101,,ND,PHY Lab 1,Group 1\n' +
  'ECE,1,A,Monday,09:00,10:00,EC101,,RDM/SRS,ECE Lab 2,Group 2\n' +
  'ECE,1,A,Monday,11:00,12:00,AS102,,PAS F1,CR 6,\n' +
  'ECE,1,A,Tuesday,09:00,10:00,MS101,,APS,CR 6,\n';

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

  const filled = Array.from({ length: headerRow.length }, (_, i) => headerRow[i] ?? '');
  return filled.findIndex((h) => synonyms.includes(h.trim().toLowerCase()));
}

export type SpreadsheetParseResult = {
  days: TimetableDay[];

  skippedRowCount: number;
};

export async function parseSpreadsheetFile(file: File): Promise<SpreadsheetParseResult> {
  const XLSX = await getXLSX();
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
    if (row.every((cell) => String(cell).trim() === '')) continue;

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

export async function renderPdfFirstPageToJpegBlob(file: File): Promise<Blob> {
  const pdfjsLib = await getPdfjs();
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  const page = await pdf.getPage(1);

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

export async function renderAllPdfPagesToJpegBlobs(file: File): Promise<Blob[]> {
  const pdfjsLib = await getPdfjs();
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

export async function parseSpreadsheetAllSections(file: File): Promise<MultiSectionParseResult> {
  const XLSX = await getXLSX();
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

function to24Hour(hour12: number, meridiem: string): number {
  const h = hour12 % 12;
  return /pm/i.test(meridiem) ? h + 12 : h;
}

function splitRoomAndFaculty(lines: string[]): { room: string; faculty: string } {
  if (lines.length === 0) return { room: '', faculty: '' };
  if (lines.length === 1) return { room: lines[0], faculty: '' };
  return { room: lines.slice(0, -1).join(' '), faculty: lines[lines.length - 1] };
}

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

    startHour = h1 >= 1 && h1 <= 7 ? h1 + 12 : h1;
    endHour = h2 >= 1 && h2 <= 7 ? h2 + 12 : h2;
  }

  return {
    startTime: `${startHour}:${m1}`,
    endTime: `${endHour}:${m2}`,
  };
}

export function looksLikeGridWorkbook(workbook: any): boolean {
  return workbook.SheetNames.some((name: string) => detectSectionFromHeaderText(name) !== null);
}

export async function parseGridWorkbookAllSections(workbook: any): Promise<MultiSectionParseResult> {
  const XLSX = await getXLSX();
  const groups: MultiSectionGroup[] = [];
  let skippedRowCount = 0;

  for (const sheetName of workbook.SheetNames) {
    const detected = detectSectionFromHeaderText(sheetName);
    if (!detected) continue;

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
      if (!currentDay) continue;

      for (const tc of timeColumns) {
        const cellRaw = row[tc.colIndex];
        if (!cellRaw) continue;
        const cellText = String(cellRaw).trim();
        if (!cellText) continue;

        const segments = cellText.split(/\n\s*\n/).map((seg) => seg.trim()).filter(Boolean);

        for (const segment of segments) {
          const lines = segment.split('\n').map((l) => l.trim()).filter(Boolean);
          let group: string | undefined;
          let contentLines = lines;
          if (lines[0] && /^group\s*\d+$/i.test(lines[0])) {
            group = lines[0];
            contentLines = lines.slice(1);
          }
          if (contentLines.length === 0) continue;

          const dayEntry = days.find((d) => d.day === currentDay)!;
          const { room, faculty } = splitRoomAndFaculty(contentLines.slice(1));

          dayEntry.slots.push({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            startTime: tc.startTime,
            endTime: tc.endTime,
            subjectCode: contentLines[0],
            subjectName: '',
            faculty,
            room,
            ...(group ? { group } : {}),
          });
        }
      }
    }

    groups.push({ branch: detected.branch, semester: detected.semester, section: detected.section, days });
  }

  return { groups, skippedRowCount };
}

export async function parseAnySpreadsheetAllSections(file: File): Promise<MultiSectionParseResult> {
  const XLSX = await getXLSX();
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array', cellDates: false });
  if (looksLikeGridWorkbook(workbook)) {
    return parseGridWorkbookAllSections(workbook);
  }
  return parseSpreadsheetAllSections(file);
}