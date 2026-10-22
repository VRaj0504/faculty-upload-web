

import { curriculum } from './curriculum';
import { EXAM_TYPES, branchesOf } from './examSheetParser';

type Cell = string | number | null;

type SheetSpec = { name: string; rows: Cell[][]; widths?: number[]; textCols?: number[]; textFromRow?: number; textRows?: number };

const safeSheetName = (s: string) => s.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31).trim() || 'Sheet1';

export async function downloadXlsx(filename: string, sheets: SheetSpec[]) {
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  for (const s of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(s.rows);
    if (s.widths) ws['!cols'] = s.widths.map((wch) => ({ wch }));
    if (s.textCols?.length) {
      const from = s.textFromRow ?? 1;
      const to = from + (s.textRows ?? 200);
      for (let r = from; r < to; r++) {
        for (const c of s.textCols) {
          const addr = XLSX.utils.encode_cell({ r, c });
          const cell = ws[addr] ?? { t: 's', v: '' };
          if (typeof cell.v === 'number') continue;
          cell.t = 's';
          cell.v = cell.v == null ? '' : String(cell.v);
          cell.z = '@';
          ws[addr] = cell;
        }
      }
      const range = XLSX.utils.decode_range(ws['!ref'] ?? 'A1');
      range.e.r = Math.max(range.e.r, to - 1);
      range.e.c = Math.max(range.e.c, ...s.textCols);
      ws['!ref'] = XLSX.utils.encode_range(range);
    }
    XLSX.utils.book_append_sheet(wb, ws, safeSheetName(s.name));
  }
  XLSX.writeFile(wb, filename);
}

const howTo = (title: string, lines: string[]): SheetSpec => ({
  name: 'How to fill',
  rows: [[title], [], ...lines.map((l) => [l])],
  widths: [110],
});

export const GRADE_HEADERS = ['Enrollment No', 'Name', 'Total'] as const;

export function gradesTemplate(opts: {
  students: { regNo: string; name: string }[];
  branch: string;
  section: string;
  admissionYear: string;
  subjectCode: string;
  subjectName: string;
}) {
  const sec = opts.section && opts.section !== '(no section)' ? opts.section : '';

  const cls = !sec ? opts.branch : sec.toUpperCase().startsWith(opts.branch.toUpperCase()) ? sec : `${opts.branch} ${sec}`;
  const sorted = [...opts.students].sort((a, b) => a.regNo.localeCompare(b.regNo, undefined, { numeric: true }));
  return downloadXlsx(`marks-${opts.subjectCode}-${cls.replace(/\s+/g, '')}-${opts.admissionYear}.xlsx`, [
    {
      name: cls,
      rows: [
        [`${opts.subjectCode} · ${opts.subjectName} — ${cls}, admitted ${opts.admissionYear}`],
        [],
        [...GRADE_HEADERS],
        ...sorted.map((s) => [s.regNo, s.name, null]),
      ],
      widths: [18, 34, 10],
    },
    howTo('Marks sheet — how to fill', [
      '1. Fill ONLY the "Total" column on the first sheet — one number per student (e.g. 73 or 73.5).',
      '2. Absent or no score: write AB (or leave it blank). They get FF.',
      '3. Every student of this class is already listed. Don\'t add, remove or retype Enrollment Numbers.',
      '4. Don\'t rename or move the three headings: Enrollment No, Name, Total.',
      '5. Want your own working (Mid sem, End sem, Quiz…)? Add those columns to the RIGHT of Total.',
      '   Don\'t use the word "Total" in any other heading — the portal reads the first column called Total.',
      '6. Keep the marks on the FIRST sheet. Save as .xlsx and upload it on Assign grades.',
      '7. The portal shows the class statistics and lets you set grade cutoffs before anything is saved.',
    ]),
  ]);
}

export const EXAM_HEADERS = ['Date', 'Start Time', 'End Time', 'Subject Code', 'Subject Name', 'Venue'] as const;

function subjectsFor(branch: string, semester: number) {
  const branches = branchesOf(branch);
  const seen = new Map<string, string>();
  for (const b of branches) {
    for (const s of curriculum[b as keyof typeof curriculum]?.[semester] ?? []) if (!seen.has(s.code)) seen.set(s.code, s.name);
  }
  return Array.from(seen, ([code, name]) => ({ code, name }));
}

const EXAM_RULES = [
  'Date — DD/MM/YYYY, e.g. 16/11/2026 (16 November). A normal Excel date cell also works.',
  'Start Time / End Time — 24-hour like 10:00 and 13:00, or 10:00 AM and 1:00 PM. End Time can be left blank.',
  'Subject Code — exactly as in the curriculum, e.g. CS301 (spaces don\'t matter).',
  'Subject Name — the full name. Code OR name is required; both is best.',
  'Venue — optional (e.g. LT 1, CR 4). Leave blank if not decided.',
  'One row per exam. Two papers on the same day = two rows.',
  'Don\'t rename the headings or merge cells. Keep the data on the FIRST sheet.',
];

export function examClassTemplate(opts: { branch: string; semester: number; examLabel: string }) {
  const subjects = subjectsFor(opts.branch, opts.semester);
  const branchLabel = branchesOf(opts.branch).join('+');
  return downloadXlsx(`date-sheet-${branchLabel}-sem${opts.semester}-${opts.examLabel.replace(/\W+/g, '-').toLowerCase()}.xlsx`, [
    {
      name: `${branchLabel} Sem ${opts.semester}`,
      rows: [
        [...EXAM_HEADERS],
        ...(subjects.length
          ? subjects.map((s) => [null, null, null, s.code, s.name, null])
          : [['16/11/2026', '10:00', '13:00', 'CS301', 'Computer Organization and Architecture', 'LT 1']]),
      ],
      widths: [14, 12, 12, 14, 44, 14],
      textCols: [0, 1, 2],
      textRows: 120,
    },
    howTo(`${opts.examLabel} date sheet — ${branchLabel} Semester ${opts.semester}`, [
      'Every subject of this semester is already listed. Fill Date and times for each; delete the rows of subjects with no exam.',
      '',
      ...EXAM_RULES.map((r, i) => `${i + 1}. ${r}`),
    ]),
  ]);
}

export const WHOLE_COLLEGE_HEADERS = ['Branch', 'Semester', 'Exam Type', ...EXAM_HEADERS] as const;

export function examWholeCollegeTemplate() {
  const subjectRows: Cell[][] = [];
  for (const branch of ['CSE', 'ECE', 'MNC'] as const) {
    for (const [sem, list] of Object.entries(curriculum[branch])) {
      for (const s of list) subjectRows.push([branch, Number(sem), s.code, s.name]);
    }
  }
  return downloadXlsx('date-sheet-whole-college.xlsx', [
    {
      name: 'Date sheet',
      rows: [
        [...WHOLE_COLLEGE_HEADERS],
        ['CSE', 3, 'Mid Semester', '21/09/2026', '09:00', '10:30', 'CS301', 'Computer Organization and Architecture', 'LT 1'],
        ['ECE', 3, 'Mid Semester', '21/09/2026', '09:00', '10:30', 'CS301', 'Computer Organization and Architecture', 'LT 2'],
        ['CSE', 3, 'Mid Semester (Repeaters)', '05/10/2026', '09:00', '10:30', 'CS301', 'Operating System', ''],
      ],
      widths: [9, 10, 26, 14, 12, 12, 14, 44, 12],
      textCols: [3, 4, 5],
      textRows: 600,
    },
    howTo('Whole-college date sheet — how to fill', [
      'Replace the 3 example rows with your own. One row per exam per class.',
      '',
      '1. Branch — CSE, ECE or MNC.',
      '   A paper two branches sit together = one row per branch (e.g. one CSE row and one MNC row).',
      '2. Semester — a number 1 to 8.',
      `3. Exam Type — one of: ${EXAM_TYPES.map((t) => t.label).join(', ')}.`,
      ...EXAM_RULES.map((r, i) => `${i + 4}. ${r}`),
      '',
      'The "Subjects" sheet lists every subject code per branch and semester — copy codes from there.',
      'After upload you review every class\'s sheet (grid or list) before anything is published.',
    ]),
    { name: 'Subjects', rows: [['Branch', 'Semester', 'Subject Code', 'Subject Name'], ...subjectRows], widths: [9, 10, 14, 50] },
  ]);
}

export async function readSheetRows<T>(
  file: File,
  parse: (rows: unknown[][]) => T | { error: string },
): Promise<{ result: T; sheetName: string } | { error: string }> {
  const XLSX = await import('xlsx');
  const isCsv = /\.csv$/i.test(file.name);

  const wb = isCsv ? XLSX.read(await file.text(), { type: 'string', raw: true }) : XLSX.read(await file.arrayBuffer(), { type: 'array' });
  let firstError = '';
  for (const name of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, defval: '', raw: true });
    const parsed = parse(rows);
    if (parsed && typeof parsed === 'object' && 'error' in parsed) {
      firstError ||= (parsed as { error: string }).error;
      continue;
    }
    return { result: parsed as T, sheetName: name };
  }
  return { error: firstError || 'This file has no sheets.' };
}
