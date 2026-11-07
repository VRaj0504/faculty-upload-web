export const REG = /^(UG|PG|UI)\d{2}[A-Z]{2,5}\d{2,4}$/i;
const MARK = /^(\d{1,3}(\.\d{1,2})?|AB|A|ABS|ABSENT|-|NA)$/i;
const MAXED = /^(.*?)\s*[([]\s*(\d{1,3})\s*(?:marks?)?\s*[)\]]\s*$/i;

export type MarkColumn = { label: string; max: number | null };
export type MarkRow = { regNo: string; name: string; values: string[] };
export type ParsedMarks = { columns: MarkColumn[]; rows: MarkRow[]; codeGuess: string | null; semesterGuess: number | null; titleGuess: string | null };

const ROMAN: Record<string, number> = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8 };

function guessFromTitle(lines: string[]) {
  const text = lines.join(' ');
  const code = /\b([A-Z]{2,3})\s*[-–]?\s*(\d{3})\b/.exec(text.replace(/[()]/g, ' '));
  let semesterGuess: number | null = null;
  const all = Array.from(text.matchAll(/semester\s*[-–:]?\s*(VIII|VII|VI|IV|V|III|II|I|[1-8])\b/gi));
  if (all.length) {
    const v = all[all.length - 1][1].toUpperCase();
    semesterGuess = ROMAN[v] ?? Number(v);
  }
  const nameM = /subject\s*name\s*[:\-]\s*(.+?)(?:\s*[-–]?\s*\(|$)/i.exec(text);
  return {
    codeGuess: code ? `${code[1].toUpperCase()}${code[2]}` : null,
    semesterGuess,
    titleGuess: nameM ? nameM[1].trim() : null,
  };
}

function splitLabel(raw: string): MarkColumn {
  const t = String(raw ?? '').replace(/\s+/g, ' ').trim();
  const m = MAXED.exec(t);
  if (m) return { label: m[1].trim() || t, max: Number(m[2]) };
  return { label: t, max: null };
}

const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[\s._/()-]/g, '');

export function parseMarksGrid(rows: unknown[][]): ParsedMarks | { error: string } {
  const cell = (r: number, c: number) => String(rows[r]?.[c] ?? '').trim();
  let regCol = -1;
  let best = 0;
  const width = Math.max(0, ...rows.map((r) => r.length));
  for (let c = 0; c < width; c++) {
    let n = 0;
    for (let r = 0; r < rows.length; r++) if (REG.test(cell(r, c).replace(/\s+/g, ''))) n++;
    if (n > best) {
      best = n;
      regCol = c;
    }
  }
  if (regCol < 0 || best < 2) return { error: 'Could not find an enrollment number column (like UG25CSE114).' };

  const firstData = rows.findIndex((r) => REG.test(String(r?.[regCol] ?? '').replace(/\s+/g, '')));
  let header = -1;
  for (let r = firstData - 1; r >= 0 && r >= firstData - 5; r--) {
    if (rows[r]?.some((v) => String(v ?? '').trim())) {
      header = r;
      break;
    }
  }
  const title = guessFromTitle(rows.slice(0, Math.max(0, header)).map((r) => r.map((v) => String(v ?? '')).join(' ')));

  const heads = header >= 0 ? rows[header].map((v) => String(v ?? '').trim()) : [];
  const nameCol = heads.findIndex((h) => /name/i.test(h));
  const dataRows = rows.slice(firstData).filter((r) => REG.test(String(r?.[regCol] ?? '').replace(/\s+/g, '')));
  const markCols: number[] = [];
  for (let c = 0; c < width; c++) {
    if (c === regCol || c === nameCol) continue;
    const h = heads[c] ?? '';
    if (/^(s\.?\s*no\.?|sr\.?\s*no\.?|sl\.?\s*no\.?|serial|#)$/i.test(h.trim()) || /^(sno|srno|slno)$/.test(norm(h))) continue;
    if (/(enrol|reg|roll|name|branch|section|email|remark)/i.test(h) && !MAXED.test(h)) continue;
    const vals = dataRows.map((r) => String(r?.[c] ?? '').trim()).filter(Boolean);
    if (!vals.length) continue;
    const ok = vals.filter((v) => MARK.test(v)).length / vals.length;
    if (ok < 0.8) continue;
    const seq = vals.every((v, i) => Number(v) === i + 1);
    if (seq && !MAXED.test(h)) continue;
    markCols.push(c);
  }
  if (!markCols.length) return { error: 'Found the students but no marks columns.' };

  return {
    ...title,
    columns: markCols.map((c) => splitLabel(heads[c] || `Column ${c + 1}`)),
    rows: dataRows.map((r) => ({
      regNo: String(r[regCol]).replace(/\s+/g, '').toUpperCase(),
      name: nameCol >= 0 ? String(r[nameCol] ?? '').trim() : '',
      values: markCols.map((c) => String(r?.[c] ?? '').trim()),
    })),
  };
}

type Item = { str: string; x: number; y: number; w: number };

export function parseMarksPdf(pages: Item[][]): ParsedMarks | { error: string } {
  type Tok = { s: string; x0: number; x1: number; y: number; page: number };
  const toks: Tok[] = [];
  pages.forEach((items, page) => {
    for (const it of items) {
      const s = it.str.trim();
      if (!s) continue;
      const parts = s.split(/\s+/);
      if (parts.length === 1) {
        toks.push({ s, x0: it.x, x1: it.x + it.w, y: it.y, page });
        continue;
      }
      const per = it.w / s.length;
      let pos = 0;
      for (const p of parts) {
        const at = s.indexOf(p, pos);
        toks.push({ s: p, x0: it.x + at * per, x1: it.x + (at + p.length) * per, y: it.y, page });
        pos = at + p.length;
      }
    }
  });
  const lines: Tok[][] = [];
  for (const t of toks.sort((a, b) => a.page - b.page || b.y - a.y || a.x0 - b.x0)) {
    const last = lines[lines.length - 1];
    if (last && last[0].page === t.page && Math.abs(last[0].y - t.y) <= 3) last.push(t);
    else lines.push([t]);
  }
  lines.forEach((l) => l.sort((a, b) => a.x0 - b.x0));

  const text = (l: Tok[]) => l.map((t) => t.s).join(' ');
  const headerIdx = lines.findIndex((l) => /\(\s*\d{1,3}\s*\)/.test(text(l)) && !l.some((t) => REG.test(t.s)));
  if (headerIdx < 0) return { error: 'Could not find the marks header (like "Quiz 1 (10)").' };
  const head = lines[headerIdx];
  const headPage = head[0].page;
  const cols: { label: string; max: number; cx: number }[] = [];
  let buf: Tok[] = [];
  for (const t of head) {
    buf.push(t);
    const m = /^\(?(\d{1,3})\)$/.exec(t.s) ?? /\((\d{1,3})\)$/.exec(t.s);
    if (m) {
      const stop = /^(sr|s|sl|no|no\.|enrollment|enrolment|reg|reg\.|roll|name|student|sr\.|s\.no\.?)$/i;
      const lbl: Tok[] = [];
      for (let i = buf.length - 2; i >= 0 && lbl.length < 3; i--) {
        if (stop.test(buf[i].s)) break;
        lbl.unshift(buf[i]);
      }
      const label = lbl.map((x) => x.s).join(' ') || `Column ${cols.length + 1}`;
      const x0 = lbl.length ? lbl[0].x0 : t.x0;
      cols.push({ label, max: Number(m[1]), cx: (x0 + t.x1) / 2 });
      buf = [];
    }
  }
  if (!cols.length) return { error: 'Could not read the marks columns.' };

  const title = guessFromTitle(lines.slice(0, headerIdx).map(text));
  const rows: MarkRow[] = [];
  for (const l of lines.slice(headerIdx + 1)) {
    const regI = l.findIndex((t) => REG.test(t.s));
    if (regI < 0) continue;
    const after = l.slice(regI + 1);
    let k = after.length;
    while (k > 0 && MARK.test(after[k - 1].s) && after.length - k < cols.length) k--;
    const markToks = after.slice(k);
    const nameParts = after.slice(0, k).map((t) => t.s);
    const values = cols.map(() => '');
    if (markToks.length === cols.length) markToks.forEach((t, i) => (values[i] = t.s));
    else if (l[0].page === headPage) {
      for (const t of markToks) {
        const cx = (t.x0 + t.x1) / 2;
        let bi = 0;
        cols.forEach((c, i) => {
          if (Math.abs(c.cx - cx) < Math.abs(cols[bi].cx - cx)) bi = i;
        });
        if (!values[bi]) values[bi] = t.s;
      }
    } else markToks.forEach((t, i) => (values[cols.length - markToks.length + i] = t.s));
    rows.push({ regNo: l[regI].s.toUpperCase(), name: nameParts.join(' '), values });
  }
  if (!rows.length) return { error: 'No student rows found in this PDF.' };
  return { ...title, columns: cols.map((c) => ({ label: c.label, max: c.max })), rows };
}

export type CellRead = { kind: 'num'; value: number } | { kind: 'absent' } | { kind: 'blank' } | { kind: 'bad'; raw: string };
export function readMark(raw: string, max: number): CellRead {
  const t = String(raw ?? '').trim();
  if (!t || t === '-' || /^na$/i.test(t)) return { kind: 'blank' };
  if (/^(ab|a|abs|absent)$/i.test(t)) return { kind: 'absent' };
  const n = Number(t.replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > max) return { kind: 'bad', raw: t };
  return { kind: 'num', value: Math.round(n * 100) / 100 };
}

export const COMPONENTS = [
  { id: 'quiz-1', label: 'Quiz 1', max: 10 },
  { id: 'quiz-2', label: 'Quiz 2', max: 10 },
  { id: 'quiz-3', label: 'Quiz 3', max: 10 },
  { id: 'quiz-4', label: 'Quiz 4', max: 10 },
  { id: 'mid-sem', label: 'Mid sem', max: 25 },
  { id: 'end-sem', label: 'End sem', max: 50 },
  { id: 'assignment', label: 'Assignment', max: 10 },
  { id: 'assignment-2', label: 'Assignment 2', max: 10 },
  { id: 'assignment-3', label: 'Assignment 3', max: 10 },
  { id: 'tutorial', label: 'Tutorial', max: 10 },
  { id: 'lab', label: 'Lab / Practical', max: 25 },
  { id: 'project', label: 'Project', max: 20 },
  { id: 'viva', label: 'Viva', max: 10 },
  { id: 'attendance', label: 'Attendance', max: 5 },
] as const;

export function guessComponent(label: string): string {
  const t = label.toLowerCase().replace(/[^a-z0-9]/g, '');
  const q = /quiz(\d)/.exec(t);
  if (q) return Number(q[1]) <= 4 ? `quiz-${q[1]}` : '';
  if (/^quiz$/.test(t)) return 'quiz-1';
  if (/mid/.test(t)) return 'mid-sem';
  if (/end|final/.test(t)) return 'end-sem';
  const a = /assign\w*?(\d)/.exec(t);
  if (a) return a[1] === '1' ? 'assignment' : Number(a[1]) <= 3 ? `assignment-${a[1]}` : '';
  if (/assign/.test(t)) return 'assignment';
  if (/tutor/.test(t)) return 'tutorial';
  if (/lab|pract/.test(t)) return 'lab';
  if (/project/.test(t)) return 'project';
  if (/viva/.test(t)) return 'viva';
  if (/attend/.test(t)) return 'attendance';
  return '';
}
