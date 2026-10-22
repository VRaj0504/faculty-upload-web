

export type RosterEntry = {
  regNo: string;
  name: string;
  branch: string;
  section?: string | null;
  specialization?: string | null;
  admissionYear: number;
  program?: 'UG' | 'PG';
};

export const isPg = (e: { regNo: string; program?: string }) => e.program === 'PG' || /^PG/i.test(e.regNo);

export type Batch = { key: string; year: number; pg: boolean };

export function deriveBatches(roster: RosterEntry[]): Batch[] {
  const seen = new Map<string, Batch>();
  for (const e of roster) {
    if (typeof e.admissionYear !== 'number' || !e.admissionYear) continue;
    const pg = isPg(e);
    const key = `${e.admissionYear}|${pg ? 'PG' : 'UG'}`;
    if (!seen.has(key)) seen.set(key, { key, year: e.admissionYear, pg });
  }
  return Array.from(seen.values()).sort((a, b) => b.year - a.year || Number(a.pg) - Number(b.pg));
}

export function batchLabel(b: Batch, today = new Date()): string {
  const start = today.getMonth() >= 6 ? today.getFullYear() : today.getFullYear() - 1;
  const n = start - b.year + 1;
  const prog = b.pg ? 'M.Tech' : 'B.Tech';
  if (n < 1) return `${prog} · Admission ${b.year}`;
  const suffix = n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`;
  return `${prog} ${suffix} Year (${b.year})`;
}

export type ClassGroup = {
  key: string;
  label: string;
  section: string | null;
  targets: { branch: string; section: string | null }[];
  students: RosterEntry[];
  specializations: string[];
  mainBranch: string;
};

const BRANCH_WORD = /\b(CSE|ECE|MNC)\b/i;

export function deriveClasses(roster: RosterEntry[], batch: Batch): ClassGroup[] {
  const groups = new Map<string, ClassGroup & { counts: Record<string, number> }>();
  for (const e of roster) {
    if (e.admissionYear !== batch.year || isPg(e) !== batch.pg || !e.branch) continue;
    const section = (e.section ?? '').trim() || null;
    const key = section ?? `branch:${e.branch}`;
    let g = groups.get(key);
    if (!g) {
      const label = !section ? e.branch : BRANCH_WORD.test(section) ? section : `${e.branch} ${section}`;
      g = { key, label, section, targets: [], students: [], specializations: [], mainBranch: e.branch, counts: {} };
      groups.set(key, g);
    }
    if (!g.targets.some((t) => t.branch === e.branch)) g.targets.push({ branch: e.branch, section });
    g.students.push(e);
    g.counts[e.branch] = (g.counts[e.branch] ?? 0) + 1;
    if (e.specialization && !g.specializations.includes(e.specialization)) g.specializations.push(e.specialization);
  }
  return Array.from(groups.values())
    .map(({ counts, ...g }) => {
      g.students.sort((a, b) => a.regNo.localeCompare(b.regNo));
      g.specializations.sort();
      g.mainBranch = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
      const others = g.targets.map((t) => t.branch).filter((b) => b !== g.mainBranch);
      if (others.length && g.section) g.label = `${g.label} (incl. ${others.join(', ')})`;
      return g;
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function currentSemester(admissionYear: number, pg: boolean, today = new Date()): number {
  const odd = today.getMonth() >= 6;
  const idx = odd ? today.getFullYear() - admissionYear : today.getFullYear() - admissionYear - 1;
  const sem = idx * 2 + 1 + (odd ? 0 : 1);
  return Math.min(Math.max(sem, 1), pg ? 4 : 8);
}

export const semesterOptions = (pg: boolean) => (pg ? [1, 2, 3, 4] : [1, 2, 3, 4, 5, 6, 7, 8]);

export function semesterWindow(admissionYear: number, semester: number): { from: string; to: string } {
  const startYear = admissionYear + Math.floor((semester - 1) / 2);
  return semester % 2 === 1
    ? { from: `${startYear}-07-01`, to: `${startYear}-12-31` }
    : { from: `${startYear + 1}-01-01`, to: `${startYear + 1}-06-30` };
}

export const pad2 = (n: number) => String(n).padStart(2, '0');
export const isoOf = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
export const todayIso = () => isoOf(new Date());

export function isValidIso(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

export function weekdayOf(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function prettyDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
  });
}

const FIXED_HOLIDAYS: Record<string, string> = {
  '2026-01-26': 'Republic Day', '2026-03-04': 'Holi', '2026-03-21': 'Id-ul-Fitr',
  '2026-03-31': 'Mahavir Jayanti', '2026-04-03': 'Good Friday', '2026-05-01': 'Buddha Purnima',
  '2026-05-27': 'Id-ul-Zuha', '2026-06-26': 'Muharram', '2026-08-15': 'Independence Day',
  '2026-08-26': 'Id-e-Milad', '2026-08-28': 'Rakshabandhan', '2026-09-14': 'Ganesh Chaturthi',
  '2026-10-02': "Gandhi Jayanti", '2026-10-20': 'Dussehra', '2026-11-08': 'Diwali',
  '2026-11-24': "Guru Nanak's Birthday", '2026-12-25': 'Christmas',
};
const BREAKS: { from: string; to: string; name: string }[] = [
  { from: '2026-11-06', to: '2026-11-13', name: 'Diwali Break' },
  { from: '2026-12-14', to: '2027-01-01', name: 'Semester Break' },
];

export function holidayName(iso: string, extra?: Map<string, string>): string | null {
  return FIXED_HOLIDAYS[iso] ?? extra?.get(iso) ?? BREAKS.find((b) => iso >= b.from && iso <= b.to)?.name ?? null;
}

export function dateWarnings(iso: string, ctx: { holidays?: Map<string, string>; window?: { from: string; to: string } }): string[] {
  const out: string[] = [];
  const h = holidayName(iso, ctx.holidays);
  if (h) out.push(`holiday (${h})`);
  const wd = weekdayOf(iso);
  if (wd === 0) out.push('Sunday');
  if (wd === 6) out.push('Saturday');
  if (ctx.window && (iso < ctx.window.from || iso > ctx.window.to)) out.push('outside this semester');
  return out;
}

export type SessionDoc = {
  branch: string;
  admissionYear: number;
  section: string | null;
  subjectCode: string;
  subjectName: string;
  date: string;
  lecture?: number;
  semester?: number;
  specialization?: string | null;

  hours?: number;
  kind?: 'lecture' | 'lab';
  onlyEnrollmentNumbers?: string[];
  batchLabel?: string;
  absentEnrollmentNumbers: string[];
  excusedEnrollmentNumbers?: string[];
  classSize?: number;
  source?: 'portal' | 'excel' | 'app';
  markedBy: string;
  markedByName?: string;
  markedAt?: unknown;
};

export const weightOf = (d: { hours?: number }) => Math.max(1, Math.round(d.hours ?? 1));

export const isFor = (d: SessionDoc, s: { regNo: string; specialization?: string | null }) =>
  !(d.specialization && d.specialization !== s.specialization) &&
  !(d.onlyEnrollmentNumbers && d.onlyEnrollmentNumbers.length && !d.onlyEnrollmentNumbers.includes(s.regNo));

export function pickBatch(students: RosterEntry[], spec: string): RosterEntry[] {
  const sorted = [...students].sort((a, b) => a.regNo.localeCompare(b.regNo));
  const half = Math.ceil(sorted.length / 2);
  if (spec === 'h1') return sorted.slice(0, half);
  if (spec === 'h2') return sorted.slice(half);
  if (!spec.startsWith('r:')) return sorted;
  const tail = (r: string) => Number((/(\d+)$/.exec(r) ?? [])[1] ?? NaN);
  const parts = spec.slice(2).split(/[\s,;]+/).filter(Boolean);
  return sorted.filter((st) =>
    parts.some((p) => {
      const m = /^(\d+)\s*[-–]\s*(\d+)$/.exec(p);
      if (m) return tail(st.regNo) >= +m[1] && tail(st.regNo) <= +m[2];
      if (/^\d+$/.test(p)) return tail(st.regNo) === +p;
      return st.regNo.toUpperCase() === p.toUpperCase();
    }),
  );
}

export function sessionDocId(p: {
  branch: string; admissionYear: number; section: string | null; subjectCode: string; date: string; lecture?: number;
}): string {
  const base = `${p.branch}_${p.admissionYear}_${p.section || 'NONE'}_${p.subjectCode.replace(/\//g, '-')}_${p.date}`;
  return p.lecture && p.lecture > 1 ? `${base}_L${p.lecture}` : base;
}

export const normCode = (c: string) => String(c ?? '').replace(/\s+/g, '').toUpperCase();

export const safeCode = (c: string) => normCode(c).replace(/\//g, '-');

export type RegMatch =
  | { kind: 'ok'; student: RosterEntry }
  | { kind: 'ambiguous'; token: string }
  | { kind: 'elsewhere'; token: string; student: RosterEntry }
  | { kind: 'unknown'; token: string };

const cleanReg = (s: unknown) => String(s ?? '').replace(/\s+/g, '').toUpperCase();

export function matchReg(raw: unknown, classStudents: RosterEntry[], wholeRoster: RosterEntry[]): RegMatch {
  const token = cleanReg(raw);
  const exact = classStudents.find((s) => s.regNo.toUpperCase() === token);
  if (exact) return { kind: 'ok', student: exact };

  if (/\d/.test(token)) {
    const suffix = classStudents.filter((s) => s.regNo.toUpperCase().endsWith(token));
    if (suffix.length === 1) return { kind: 'ok', student: suffix[0] };
    if (suffix.length > 1) return { kind: 'ambiguous', token };
  }
  const other = wholeRoster.find((s) => s.regNo.toUpperCase() === token);
  if (other) return { kind: 'elsewhere', token, student: other };
  return { kind: 'unknown', token };
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

const normHeader = (h: unknown) => String(h ?? '').toLowerCase().replace(/[\s._/()\-:#]/g, '');
const REG_HEADERS = ['regno', 'enrollment', 'enrolment', 'rollno', 'registrationno', 'registrationnumber', 'admissionno', 'studentid'];
const NAME_HEADERS = ['name', 'studentname', 'fullname'];

export function parseDateHeader(v: unknown, yearFor: (month: number) => number): { date: string; lecture?: number } | null {

  if (typeof v === 'number') {
    if (v < 40000 || v > 60000) return null;
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(v + 1e-6) * 86400000);
    return { date: `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}` };
  }
  if (v instanceof Date && !isNaN(v.getTime())) return { date: isoOf(v) };
  if (typeof v !== 'string') return null;
  let s = v.trim();
  if (!s) return null;

  let lecture: number | undefined;
  const lec = /(?:\bL|lec(?:ture)?\s*|\()\s*([1-9])\)?\s*$/i.exec(s) ?? /^(?:L|lec(?:ture)?)\s*([1-9])\b/i.exec(s);
  if (lec) {
    lecture = Number(lec[1]);
    s = s.replace(lec[0], ' ').trim();
  }
  s = s.replace(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*[,\s]+/i, '').replace(/[,\s]+(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?$/i, '').trim();

  const mk = (y: number, m: number, d: number) => {
    if (y < 100) y += 2000;
    const iso = `${y}-${pad2(m)}-${pad2(d)}`;
    return isValidIso(iso) ? { date: iso, lecture } : null;
  };
  let m: RegExpExecArray | null;
  if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T].*)?$/.exec(s))) return mk(+m[1], +m[2], +m[3]);

  if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(s))) return mk(+m[3], +m[2], +m[1]);
  if ((m = /^(\d{1,2})[-/.](\d{1,2})$/.exec(s))) return mk(yearFor(+m[2]), +m[2], +m[1]);
  if ((m = /^(\d{1,2})(?:st|nd|rd|th)?[-\s/.]*([a-z]{3,9})\.?[-\s/,.']*(\d{2,4})?$/i.exec(s))) {
    const mon = MONTHS[m[2].toLowerCase().slice(0, m[2].toLowerCase().startsWith('sept') ? 4 : 3)];
    if (mon) return mk(m[3] ? +m[3] : yearFor(mon), mon, +m[1]);
  }
  if ((m = /^([a-z]{3,9})\.?[-\s/.]*(\d{1,2})(?:st|nd|rd|th)?[,\s'-]*(\d{2,4})?$/i.exec(s))) {
    const mon = MONTHS[m[1].toLowerCase().slice(0, m[1].toLowerCase().startsWith('sept') ? 4 : 3)];
    if (mon) return mk(m[3] ? +m[3] : yearFor(mon), mon, +m[2]);
  }
  return null;
}

export type CellKind = 'P' | 'A' | 'E' | 'NA' | 'blank' | 'unknown';
const PRESENT = new Set(['p', 'present', '1', 'y', 'yes', 'true', '✓', '✔', '✅', 'pr', 'pres']);
const ABSENT = new Set(['a', 'ab', 'abs', 'absent', '0', 'n', 'no', 'false', 'x', '✗', '✘', '❌']);
const EXCUSED = new Set(['od', 'ml', 'l', 'le', 'leave', 'e', 'ex', 'excused', 'dl', 'duty', 'onduty']);

export function classifyCell(v: unknown): CellKind {
  if (v === undefined || v === null) return 'blank';
  const s = String(v).trim().toLowerCase().replace(/\.$/, '');
  if (!s || s === '-' || s === '–') return 'blank';
  if (s === '—' || s === 'na' || s === 'n/a') return 'NA';
  if (PRESENT.has(s)) return 'P';
  if (ABSENT.has(s)) return 'A';
  if (EXCUSED.has(s.replace(/[\s.]/g, ''))) return 'E';
  return 'unknown';
}

export type RegisterColumn = { col: number; header: string; date: string; lecture: number; hours?: number };

export type ParsedRegister = {
  headerRow: number;
  regCol: number;
  nameCol: number | null;
  columns: RegisterColumn[];
  skippedHeaders: string[];
  rows: { regNo: string; name: string; cells: unknown[]; rowNumber: number }[];
  duplicateRegs: string[];
};

const MONTH_CELL = /^\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?[\s,'-]*(\d{2,4})?\s*$/i;

function splitDateColumns(
  grid: unknown[][],
  headerRow: number,
  regCol: number,
  nameCol: number | null,
  yearFor: (month: number) => number,
): RegisterColumn[] {

  let monthRow = -1;
  for (let r = headerRow; r >= Math.max(0, headerRow - 8); r--) {
    if ((grid[r] ?? []).some((v) => typeof v === 'string' && MONTH_CELL.test(v))) {
      monthRow = r;
      break;
    }
  }
  if (monthRow === -1) return [];
  const mrow = grid[monthRow] ?? [];
  const width = Math.max(...grid.slice(monthRow, headerRow + 30).map((r) => (r ?? []).length));

  const monthOf: ({ month: number; year?: number } | null)[] = [];
  let cur: { month: number; year?: number } | null = null;
  for (let c = 0; c < width; c++) {
    const v = mrow[c];
    if (v !== null && v !== undefined && String(v).trim()) {
      const m = MONTH_CELL.exec(String(v));
      if (m) {
        const key = m[1].toLowerCase();
        cur = { month: MONTHS[key.startsWith('sept') ? 'sep' : key.slice(0, 3)], year: m[2] ? (+m[2] < 100 ? 2000 + +m[2] : +m[2]) : undefined };
      } else cur = null;
    }
    monthOf[c] = c === regCol || c === nameCol ? null : cur;
  }

  let best: { row: number; count: number } | null = null;
  for (let r = monthRow; r <= headerRow; r++) {
    const vals: number[] = [];
    for (let c = 0; c < width; c++) {
      if (!monthOf[c]) continue;
      const v = (grid[r] ?? [])[c];
      const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,2}$/.test(v.trim()) ? Number(v) : NaN;
      if (Number.isInteger(n) && n >= 1 && n <= 31) vals.push(n);
    }
    const serial = vals.length > 3 && vals.every((n, i) => n === i + 1);
    if (!serial && vals.length && (!best || vals.length > best.count)) best = { row: r, count: vals.length };
  }
  if (!best) return [];

  const out: RegisterColumn[] = [];
  const drow = grid[best.row] ?? [];
  for (let c = 0; c < width; c++) {
    const mo = monthOf[c];
    if (!mo) continue;
    const v = drow[c];
    const d = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.trim()) : NaN;
    if (!Number.isInteger(d) || d < 1 || d > 31) continue;
    const y = mo.year ?? yearFor(mo.month);
    const iso = `${y}-${pad2(mo.month)}-${pad2(d)}`;
    if (!isValidIso(iso)) continue;
    out.push({ col: c, header: `${d} ${Object.keys(MONTHS).find((k) => MONTHS[k] === mo.month)}`, date: iso, lecture: 0 });
  }
  return out;
}

export function parseRegister(
  grid: unknown[][],
  yearFor: (month: number) => number,
): ParsedRegister | { error: string } {
  if (!grid.length) return { error: 'This sheet is empty.' };

  let headerRow = -1;
  let regCol = -1;
  let nameCol: number | null = null;
  for (let i = 0; i < Math.min(grid.length, 15); i++) {
    const cells = (grid[i] ?? []).map(normHeader);
    const r = cells.findIndex((h) => REG_HEADERS.some((a) => h.includes(a)));
    if (r !== -1) {
      headerRow = i;
      regCol = r;
      const n = cells.findIndex((h, idx) => idx !== r && NAME_HEADERS.some((a) => h === a || h.endsWith(a)));
      nameCol = n === -1 ? null : n;
      break;
    }
  }
  if (headerRow === -1) {
    return {
      error:
        'Couldn’t find the header row. The sheet needs a row with “Reg. No.” (or Enrollment No.) above the students, and the class dates in that same row.',
    };
  }

  const header = grid[headerRow] ?? [];
  const columns: RegisterColumn[] = [];
  const skippedHeaders: string[] = [];
  const width = Math.max(header.length, ...grid.slice(headerRow + 1, headerRow + 200).map((r) => (r ?? []).length));
  for (let c = 0; c < width; c++) {
    if (c === regCol || c === nameCol) continue;
    const h = header[c];
    if (h === undefined || h === null || String(h).trim() === '') continue;
    const parsed = parseDateHeader(h, yearFor);
    if (parsed) columns.push({ col: c, header: String(h).trim(), date: parsed.date, lecture: parsed.lecture ?? 0 });
    else skippedHeaders.push(String(h).trim());
  }

  if (columns.length < 2) {
    const split = splitDateColumns(grid, headerRow, regCol, nameCol, yearFor);
    if (split.length > columns.length) {
      columns.length = 0;
      columns.push(...split);
      const used = new Set(split.map((c) => c.col));
      skippedHeaders.length = 0;
      header.forEach((h, c) => {
        if (c === regCol || c === nameCol || used.has(c) || h === null || h === undefined) return;
        if (String(h).trim() && typeof h !== 'number') skippedHeaders.push(String(h).trim());
      });
    }
  }

  if (!columns.length) {
    return {
      error: `Found the header row (row ${headerRow + 1}) but none of its columns is a date. Put each class date (e.g. 12/08/2026) as a column heading.`,
    };
  }

  const byDate = new Map<string, RegisterColumn[]>();
  columns.forEach((c) => byDate.set(c.date, [...(byDate.get(c.date) ?? []), c]));
  byDate.forEach((cols) => {
    const used = new Set(cols.filter((c) => c.lecture > 0).map((c) => c.lecture));
    let next = 1;
    for (const c of cols) {
      if (c.lecture > 0) continue;
      while (used.has(next)) next++;
      c.lecture = next;
      used.add(next);
    }
  });
  columns.sort((a, b) => a.date.localeCompare(b.date) || a.lecture - b.lecture);

  for (let i = headerRow + 1; i < Math.min(grid.length, headerRow + 4); i++) {
    const r = grid[i] ?? [];
    if (![r[0], r[1], r[regCol]].some((v) => /^hours?$/i.test(String(v ?? '').trim()))) continue;
    for (const c of columns) {
      const h = Number(r[c.col]);
      if (Number.isFinite(h) && h >= 1 && h <= 4) c.hours = Math.round(h);
    }
    break;
  }

  const rows: ParsedRegister['rows'] = [];
  const seen = new Set<string>();
  const duplicateRegs: string[] = [];
  for (let i = headerRow + 1; i < grid.length; i++) {
    const r = grid[i] ?? [];
    const regNo = cleanReg(r[regCol]);

    if (!regNo || !/\d/.test(regNo) || /^(TOTAL|AVG|AVERAGE|PRESENT|ABSENT)/.test(regNo)) continue;
    if (seen.has(regNo)) duplicateRegs.push(regNo);
    seen.add(regNo);
    rows.push({
      regNo,
      name: nameCol !== null ? String(r[nameCol] ?? '').trim() : '',
      cells: columns.map((c) => r[c.col]),
      rowNumber: i + 1,
    });
  }
  if (!rows.length) return { error: 'Found the header row but no student rows under it.' };
  return { headerRow, regCol, nameCol, columns, skippedHeaders, rows, duplicateRegs };
}

export function guessBlankMeaning(p: ParsedRegister): 'present' | 'absent' {
  let P = 0;
  let A = 0;
  for (const r of p.rows) for (const v of r.cells) {
    const k = classifyCell(v);
    if (k === 'P') P++;
    else if (k === 'A') A++;
  }
  return P > 0 && A === 0 ? 'absent' : 'present';
}

export type BuiltSession = {
  date: string;
  lecture: number;
  header: string;
  absent: RosterEntry[];
  excused: RosterEntry[];
  na: RosterEntry[];
  hours?: number;
  present: number;
  empty: boolean;
};

export type RegisterPlan = {
  sessions: BuiltSession[];
  unknownValues: { value: string; count: number }[];
  ambiguous: string[];
  elsewhere: { regNo: string; name: string; where: string }[];
  unknownRegs: { regNo: string; name: string }[];
  missingFromSheet: RosterEntry[];
  matched: number;
};

export function planRegister(
  p: ParsedRegister,
  opts: { blank: 'present' | 'absent'; unknown: 'present' | 'absent'; missing: 'present' | 'absent' | 'skip' },
  classStudents: RosterEntry[],
  wholeRoster: RosterEntry[],
): RegisterPlan {
  const unknownCounts = new Map<string, number>();
  const ambiguous: string[] = [];
  const elsewhere: RegisterPlan['elsewhere'] = [];
  const unknownRegs: RegisterPlan['unknownRegs'] = [];
  const matchedRows: { student: RosterEntry; cells: unknown[] }[] = [];
  const matchedIds = new Set<string>();

  for (const row of p.rows) {
    const m = matchReg(row.regNo, classStudents, wholeRoster);
    if (m.kind === 'ok') {
      if (matchedIds.has(m.student.regNo)) {

        const i = matchedRows.findIndex((x) => x.student.regNo === m.student.regNo);
        matchedRows.splice(i, 1);
      }
      matchedRows.push({ student: m.student, cells: row.cells });
      matchedIds.add(m.student.regNo);
    } else if (m.kind === 'ambiguous') ambiguous.push(m.token);
    else if (m.kind === 'elsewhere') {
      const st = m.student;
      const sec = st.section && BRANCH_WORD.test(st.section) ? st.section : [st.branch, st.section].filter(Boolean).join(' ');
      elsewhere.push({ regNo: st.regNo, name: st.name, where: `${sec}, ${st.admissionYear} batch` });
    } else unknownRegs.push({ regNo: row.regNo, name: row.name });
  }
  const missingFromSheet = classStudents.filter((s) => !matchedIds.has(s.regNo));

  const sessions: BuiltSession[] = p.columns.map((col, ci) => {
    const absent: RosterEntry[] = [];
    const excused: RosterEntry[] = [];
    const na: RosterEntry[] = [];
    let nonBlank = 0;
    for (const { student, cells } of matchedRows) {
      const v = cells[ci];
      let k = classifyCell(v);
      if (k === 'NA') {
        na.push(student);
        continue;
      }
      if (k !== 'blank') nonBlank++;
      if (k === 'unknown') {
        const key = String(v).trim();
        unknownCounts.set(key, (unknownCounts.get(key) ?? 0) + 1);
        k = opts.unknown === 'absent' ? 'A' : 'P';
      }
      if (k === 'blank') k = opts.blank === 'absent' ? 'A' : 'P';
      if (k === 'A') absent.push(student);
      else if (k === 'E') excused.push(student);
    }
    const total = matchedRows.length - na.length + (opts.missing === 'absent' ? missingFromSheet.length : 0);
    if (opts.missing === 'absent') absent.push(...missingFromSheet);
    if (opts.missing === 'skip') na.push(...missingFromSheet);
    return {
      date: col.date,
      lecture: col.lecture,
      header: col.header,
      absent,
      excused,
      na,
      hours: col.hours,
      present: total - absent.length - excused.length,
      empty: nonBlank === 0,
    };
  });

  return {
    sessions,
    unknownValues: Array.from(unknownCounts, ([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count),
    ambiguous,
    elsewhere,
    unknownRegs,
    missingFromSheet,
    matched: matchedRows.length,
  };
}

export type ExportSubject = { code: string; name: string; sessions: SessionDoc[] };
export type ExcusalRange = { fromDate: string; toDate: string; eventName?: string };
type Cell = string | number | null;
export type SheetSpec = { name: string; rows: Cell[][]; widths?: number[] };

export const LOW_ATTENDANCE = 75;
const pct = (a: number, t: number) => (t ? Math.round((a / t) * 1000) / 10 : null);

export function studentRecord(
  s: RosterEntry,
  sessions: SessionDoc[],
  excusals: ExcusalRange[] = [],
): { marks: (string | null)[]; attended: number; total: number; classes: number } {
  let attended = 0;
  let total = 0;
  let classes = 0;
  const marks = sessions.map((d) => {
    if (d.branch !== s.branch || !isFor(d, s)) return null;
    const w = weightOf(d);
    total += w;
    classes++;
    const absent = d.absentEnrollmentNumbers.includes(s.regNo);
    const excused = d.excusedEnrollmentNumbers?.includes(s.regNo);
    if (excused || (absent && excusals.some((r) => d.date >= r.fromDate && d.date <= r.toDate))) {
      attended += w;
      return 'OD';
    }
    if (absent) return 'A';
    attended += w;
    return 'P';
  });

  return { marks, attended, total, classes };
}

function columnsOf(sessions: SessionDoc[]): { key: string; label: string; docs: SessionDoc[] }[] {
  const map = new Map<string, { key: string; label: string; docs: SessionDoc[] }>();
  for (const d of sessions) {
    const lec = d.lecture ?? 1;
    const key = `${d.date}#${lec}`;
    if (!map.has(key)) {
      const [y, m, dd] = d.date.split('-');
      map.set(key, { key, label: `${dd}/${m}/${y}${lec > 1 ? ` L${lec}` : ''}`, docs: [] });
    }
    map.get(key)!.docs.push(d);
  }
  return Array.from(map.values()).sort((a, b) => a.key.localeCompare(b.key));
}

export function buildSemesterWorkbook(params: {
  title: string;
  students: RosterEntry[];
  subjects: ExportSubject[];
  excusals: Map<string, ExcusalRange[]>;
}): SheetSpec[] {
  const { students, subjects, excusals } = params;
  const withData = subjects.filter((s) => s.sessions.length);
  const summaryHead: Cell[] = ['Reg. No.', 'Name', 'Branch'];
  withData.forEach((s) => summaryHead.push(`${s.code} %`));
  summaryHead.push('Overall attended', 'Overall held', 'Overall %', `Below ${LOW_ATTENDANCE}% in`);

  const summary: Cell[][] = [[params.title], [`Generated ${new Date().toLocaleString('en-IN')}`], [], summaryHead];
  const subjectSheets: SheetSpec[] = [];
  const perStudent = new Map<string, { attended: number; total: number; low: string[]; pcts: (number | null)[] }>();
  students.forEach((s) => perStudent.set(s.regNo, { attended: 0, total: 0, low: [], pcts: [] }));

  for (const subj of withData) {
    const cols = columnsOf(subj.sessions);
    const head: Cell[] = ['Reg. No.', 'Name', ...cols.map((c) => c.label), 'Attended (hrs)', 'Held (hrs)', '%'];

    const hoursRow: Cell[] = ['Hours', '', ...cols.map((c) => weightOf(c.docs[0])), '', '', ''];
    const rows: Cell[][] = [[`${subj.code} — ${subj.name}`], [params.title], [], head, hoursRow];
    for (const s of students) {
      const own = cols.map((c) => c.docs.find((d) => d.branch === s.branch) ?? null);
      const rec = studentRecord(s, own.filter((d): d is SessionDoc => !!d), excusals.get(s.regNo));
      let k = 0;
      const marks = own.map((d) => (d ? rec.marks[k++] : null));
      const p = pct(rec.attended, rec.total);
      rows.push([s.regNo, s.name, ...marks.map((m) => m ?? '—'), rec.attended, rec.total, p]);
      const agg = perStudent.get(s.regNo)!;
      agg.pcts.push(p);
      agg.attended += rec.attended;
      agg.total += rec.total;
      if (p !== null && p < LOW_ATTENDANCE) agg.low.push(subj.code);
    }

    const present: Cell[] = ['', 'Present in class', ...cols.map((c) => {
      let n = 0;
      for (const s of students) {
        const d = c.docs.find((x) => x.branch === s.branch);
        if (d && isFor(d, s) && !d.absentEnrollmentNumbers.includes(s.regNo)) n++;
      }
      return n;
    })];
    rows.push([], present);
    subjectSheets.push({ name: subj.code, rows, widths: [14, 28, ...cols.map(() => 11), 9, 7, 7] });
  }

  for (const s of students) {
    const a = perStudent.get(s.regNo)!;
    summary.push([s.regNo, s.name, s.branch, ...a.pcts, a.attended, a.total, pct(a.attended, a.total), a.low.join(', ')]);
  }
  const lowCount = Array.from(perStudent.values()).filter((a) => a.low.length).length;
  summary.push([], [`${lowCount} student(s) below ${LOW_ATTENDANCE}% in at least one subject.`]);
  if (!withData.length) summary.push(['No attendance has been recorded for this class and semester yet.']);

  const key: SheetSpec = {
    name: 'Key',
    rows: [
      ['P = present, A = absent, OD = on duty / leave / approved event (counts as attended)'],
      ['— = not this student’s class (another lab batch, branch or specialization) — not counted'],
      ['Hours row: 1 = lecture, 2 = 2-hour lab/workshop. Attendance % = hours attended ÷ hours held.'],
      ['L2, L3 = second or third class of the same subject on that day'],
      ['Percentages match what students see in the app.'],
      ['Medical leaves confirmed in the app are not included here.'],
    ],
    widths: [90],
  };
  return [
    { name: 'Summary', rows: summary, widths: [14, 28, 8, ...withData.map(() => 10), 15, 12, 10, 24] },
    ...subjectSheets,
    key,
  ];
}

export type PdfTextItem = { str: string; x: number; y: number; w: number };

const REG_TOKEN = /^(UG|PG)\d{2}[A-Z]{2,5}\d{2,4}$/i;
const MONTH_WORD = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?$/i;

export function gridFromPdfPages(pages: PdfTextItem[][]): unknown[][] | { error: string } {

  type Tok = { s: string; cx: number; y: number; page: number; x0: number };
  const toks: Tok[] = [];
  pages.forEach((items, page) => {
    for (const it of items) {
      const s = it.str.trim();
      if (!s) continue;
      const parts = s.split(/\s+/);
      if (parts.length > 1 && parts.every((p) => p.length <= 3)) {
        parts.forEach((p, i) => toks.push({ s: p, cx: it.x + (it.w * (i + 0.5)) / parts.length, y: it.y, page, x0: it.x }));
      } else toks.push({ s, cx: it.x + it.w / 2, y: it.y, page, x0: it.x });
    }
  });
  if (toks.length < 20) {
    return { error: 'This PDF has no readable text — it’s probably a scan or photo. Ask the teacher for the Excel file instead.' };
  }

  const lines: Tok[][] = [];
  for (const t of toks.sort((a, b) => a.page - b.page || b.y - a.y || a.cx - b.cx)) {
    const last = lines[lines.length - 1];
    if (last && last[0].page === t.page && Math.abs(last[0].y - t.y) <= 2.5) last.push(t);
    else lines.push([t]);
  }
  lines.forEach((l) => l.sort((a, b) => a.cx - b.cx));

  const isDay = (s: string) => /^\d{1,2}$/.test(s) && +s >= 1 && +s <= 31;
  let headerIdx = -1;
  let best = 0;
  lines.forEach((l, i) => {
    const n = l.filter((t) => isDay(t.s)).length;
    if (n > best && !l.some((t) => REG_TOKEN.test(t.s))) {
      best = n;
      headerIdx = i;
    }
  });
  if (headerIdx === -1 || best < 2) return { error: 'Couldn’t find the row of class dates in this PDF.' };
  const dayToks = lines[headerIdx].filter((t) => isDay(t.s));

  if (dayToks.length > 3 && dayToks.every((t, i) => +t.s === i + 1)) {
    return { error: 'The PDF’s header row is a 1, 2, 3 … class count, not dates. Ask for the Excel file instead.' };
  }

  const months: number[] = [];
  for (let i = headerIdx - 1; i >= 0 && lines[i][0].page === lines[headerIdx][0].page && headerIdx - i <= 4; i--) {
    const found = lines[i].filter((t) => MONTH_WORD.test(t.s));
    if (found.length) {
      found.forEach((t) => {
        const k = t.s.toLowerCase();
        months.push(MONTHS[k.startsWith('sept') ? 'sep' : k.slice(0, 3)]);
      });
      break;
    }
  }
  if (!months.length) return { error: 'Couldn’t find the month names above the dates in this PDF.' };
  const monthNames = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  let mi = 0;
  const headers = dayToks.map((t, i) => {
    if (i > 0 && +t.s < +dayToks[i - 1].s && mi < months.length - 1) mi++;
    return `${+t.s} ${monthNames[months[mi]]}`;
  });

  const xs = dayToks.map((t) => t.cx);
  const gaps = xs.slice(1).map((x, i) => x - xs[i]).filter((g) => g > 0.5);
  const tol = Math.max(2, Math.min(...gaps, 20) * 0.48);
  const firstX = xs[0];

  const grid: unknown[][] = [['Reg. No.', 'Name', ...headers]];
  for (const l of lines) {
    const reg = l.find((t) => REG_TOKEN.test(t.s));
    if (!reg) continue;
    const name = l
      .filter((t) => t !== reg && t.cx > reg.cx && t.cx < firstX - tol && !/^[PA]$/i.test(t.s))
      .map((t) => t.s)
      .join(' ');
    const row: unknown[] = [reg.s.toUpperCase(), name, ...headers.map(() => null)];
    for (const t of l) {
      if (t === reg || t.cx < firstX - tol) continue;
      let bi = -1;
      let bd = Infinity;
      xs.forEach((x, i) => {
        const d = Math.abs(x - t.cx);
        if (d < bd) {
          bd = d;
          bi = i;
        }
      });
      if (bi !== -1 && bd <= tol && row[bi + 2] === null) row[bi + 2] = t.s;
    }
    grid.push(row);
  }
  if (grid.length < 2) return { error: 'Found the dates but no student rows (Reg. No. like UG26CSE101) in this PDF.' };
  return grid;
}
