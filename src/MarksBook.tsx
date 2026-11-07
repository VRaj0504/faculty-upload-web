import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { addDoc, collection, deleteField, doc, getDocs, query, serverTimestamp, where, writeBatch } from 'firebase/firestore';
import { auth, db } from './firebaseConfig';
import { loadSubjectIndex, type SubjectInfo } from './examData';
import { loadApprovedExcusals, loadRoster } from './attendanceData';
import { normCode, studentRecord, type ExcusalRange, type RosterEntry, type SessionDoc } from './attendanceCore';
import { COMPONENTS, guessComponent, parseMarksGrid, parseMarksPdf, readMark, type ParsedMarks } from './marksImport';
import { downloadXlsx, readSheetRows } from './xlsxTemplates';
import './MarksBook.css';

type Col = { id: string; label: string; max: number };
type Saved = { score: number | null; absent: boolean; max: number; overridden: boolean };
type Band = { min: number; marks: number };
type Att = { attended: number; total: number; pct: number | null };

const SEMS = [1, 2, 3, 4, 5, 6, 7, 8];
const ALL = '__all__';
const ATT = 'attendance';
const MAXES = [2, 3, 4, 5, 10, 15, 20, 25, 30, 40, 50, 60, 75, 100];
const PCTS = Array.from({ length: 21 }, (_, i) => 100 - i * 5);
const DEFAULT_BANDS: Band[] = [
  { min: 75, marks: 5 },
  { min: 60, marks: 4 },
  { min: 50, marks: 3 },
  { min: 40, marks: 2 },
  { min: 0, marks: 0 },
];
const PICK_KEY = 'cg-marksbook-pick';
const safe = (c: string) => c.replace(/\s+/g, '').toUpperCase().replace(/\//g, '-');
const bandsKey = (code: string) => `cg-att-bands:${safe(code)}`;
const k = (reg: string, col: string) => `${reg}|${col}`;
const orderOf = (id: string) => {
  const i = COMPONENTS.findIndex((c) => c.id === id);
  return i === -1 ? 99 : i;
};
const labelOf = (id: string) => COMPONENTS.find((c) => c.id === id)?.label ?? id;
const defMax = (id: string) => COMPONENTS.find((c) => c.id === id)?.max ?? 10;
const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, ''));

function currentSem(admissionYear: number, now = new Date()) {
  const isOdd = now.getMonth() >= 6;
  const idx = isOdd ? now.getFullYear() - admissionYear : now.getFullYear() - admissionYear - 1;
  return Math.min(8, Math.max(1, idx * 2 + 1 + (isOdd ? 0 : 1)));
}
const classKeyOf = (r: RosterEntry) => `${r.branch}|${r.section ?? ''}|${r.admissionYear}`;
const classLabelOf = (r: RosterEntry) => (r.section ? (/^(CSE|ECE|MNC)/i.test(r.section) ? r.section : `${r.branch} ${r.section}`) : r.branch);

function marksFor(pct: number, bands: Band[]): number {
  for (const b of [...bands].sort((a, x) => x.min - a.min)) if (pct >= b.min) return b.marks;
  return 0;
}
function rangeText(sorted: Band[], i: number) {
  const b = sorted[i];
  if (i === 0) return `${b.min}% and above`;
  const up = sorted[i - 1].min;
  return b.min === 0 ? `Below ${up}%` : `${b.min}% to under ${up}%`;
}

function readPick(): { semester: string; code: string; cls: string } {
  try {
    const raw = localStorage.getItem(PICK_KEY);
    if (raw) return { semester: '', code: '', cls: ALL, ...JSON.parse(raw) };
  } catch {
    return { semester: '', code: '', cls: ALL };
  }
  return { semester: '', code: '', cls: ALL };
}

export default function MarksBook() {
  const first = useRef(readPick());
  const [roster, setRoster] = useState<RosterEntry[] | null>(null);
  const [subjects, setSubjects] = useState<SubjectInfo[]>([]);
  const [loadErr, setLoadErr] = useState('');
  const [semester, setSemester] = useState(first.current.semester);
  const [code, setCode] = useState(first.current.code);
  const [cls, setCls] = useState(first.current.cls);

  const [cols, setCols] = useState<Col[]>([]);
  const [saved, setSaved] = useState<Map<string, Record<string, Saved>>>(new Map());
  const [cells, setCells] = useState<Record<string, string>>({});
  const [att, setAtt] = useState<Map<string, Att> | null>(null);
  const [attOn, setAttOn] = useState(false);
  const [bands, setBands] = useState<Band[]>(DEFAULT_BANDS);
  const [editBands, setEditBands] = useState(false);
  const [excusalsOk, setExcusalsOk] = useState(true);
  const [loading, setLoading] = useState(false);
  const [addId, setAddId] = useState('');
  const [addMax, setAddMax] = useState(10);
  const [notify, setNotify] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'warn' | 'err'; text: string } | null>(null);
  const [fileKey, setFileKey] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    Promise.all([loadRoster(), loadSubjectIndex()])
      .then(([r, idx]) => {
        setRoster(r);
        setSubjects(Array.from(idx.values()));
      })
      .catch((e) => setLoadErr(`Couldn't load the student list: ${e.message}`));
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(PICK_KEY, JSON.stringify({ semester, code, cls }));
    } catch {
      return;
    }
  }, [semester, code, cls]);

  const subjectOptions = useMemo(() => {
    const seen = new Map<string, SubjectInfo & { branches: string[] }>();
    for (const s of subjects) {
      if (String(s.semester) !== semester) continue;
      const hit = seen.get(s.code);
      if (hit) {
        if (!hit.branches.includes(s.branch)) hit.branches.push(s.branch);
      } else seen.set(s.code, { ...s, branches: [s.branch] });
    }
    return Array.from(seen.values()).sort((a, b) => a.code.localeCompare(b.code));
  }, [subjects, semester]);
  const subject = subjectOptions.find((s) => s.code === code) ?? null;

  const takers = useMemo(() => {
    if (!roster || !subject) return [];
    return roster.filter((r) => subject.branches.includes(r.branch) && currentSem(r.admissionYear) === Number(semester));
  }, [roster, subject, semester]);

  const classOptions = useMemo(() => {
    const m = new Map<string, { key: string; label: string; count: number }>();
    for (const r of takers) {
      const key = classKeyOf(r);
      const hit = m.get(key);
      if (hit) hit.count++;
      else m.set(key, { key, label: classLabelOf(r), count: 1 });
    }
    return Array.from(m.values()).sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  }, [takers]);

  useEffect(() => {
    if (cls !== ALL && classOptions.length && !classOptions.some((c) => c.key === cls)) setCls(ALL);
  }, [classOptions, cls]);

  const students = useMemo(
    () => (cls === ALL ? takers : takers.filter((r) => classKeyOf(r) === cls)).slice().sort((a, b) => a.regNo.localeCompare(b.regNo)),
    [takers, cls],
  );
  const studentKey = students.map((s) => s.regNo).join(',');

  const load = useCallback(async () => {
    if (!subject || !students.length) return;
    setLoading(true);
    setMsg(null);
    try {
      const regs = new Set(students.map((s) => s.regNo));
      const sv = new Map<string, Record<string, Saved>>();
      const maxVotes = new Map<string, Map<number, number>>();
      const ms = await getDocs(query(collection(db, 'marks'), where('subjectCode', '==', subject.code)));
      ms.docs.forEach((d) => {
        const x = d.data() as { enrollmentNumber?: string; components?: Record<string, { score?: number | null; absent?: boolean; max?: number; overridden?: boolean }> };
        if (!x.enrollmentNumber || !regs.has(x.enrollmentNumber)) return;
        const rec: Record<string, Saved> = {};
        for (const [id, c] of Object.entries(x.components ?? {})) {
          if (!c) continue;
          const max = Number(c.max) || defMax(id);
          rec[id] = { score: typeof c.score === 'number' ? c.score : null, absent: c.absent === true, max, overridden: c.overridden === true };
          const v = maxVotes.get(id) ?? new Map<number, number>();
          v.set(max, (v.get(max) ?? 0) + 1);
          maxVotes.set(id, v);
        }
        sv.set(x.enrollmentNumber, rec);
      });

      let bandPick: { outOf: number; bands: Band[] } | null = null;
      const uid = auth.currentUser?.uid;
      if (uid) {
        try {
          const up = await getDocs(query(collection(db, 'marksUploads'), where('uploadedBy', '==', uid)));
          const mine = up.docs
            .map((d) => d.data() as { subjectCode?: string; attendanceBands?: Band[]; components?: { id: string; max: number }[]; createdAt?: { toMillis?: () => number } })
            .filter((d) => d.subjectCode === subject.code && Array.isArray(d.attendanceBands))
            .sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
          if (mine[0]) bandPick = { bands: mine[0].attendanceBands!, outOf: mine[0].components?.find((c) => c.id === ATT)?.max ?? 5 };
        } catch {
          bandPick = null;
        }
      }
      if (!bandPick) {
        try {
          const raw = localStorage.getItem(bandsKey(subject.code));
          if (raw) bandPick = JSON.parse(raw);
        } catch {
          bandPick = null;
        }
      }

      const ids = Array.from(maxVotes.keys()).filter((id) => id !== ATT).sort((a, b) => orderOf(a) - orderOf(b));
      const topMax = (id: string) => {
        const v = maxVotes.get(id);
        if (!v) return defMax(id);
        return Array.from(v.entries()).sort((a, b) => b[1] - a[1])[0][0];
      };
      const attMax = maxVotes.has(ATT) ? topMax(ATT) : bandPick?.outOf ?? 5;
      const nextCols: Col[] = [...ids.map((id) => ({ id, label: labelOf(id), max: topMax(id) })), { id: ATT, label: 'Attendance', max: attMax }];

      const nextCells: Record<string, string> = {};
      sv.forEach((rec, reg) => {
        for (const [id, s] of Object.entries(rec)) {
          if (id === ATT) {
            if (s.overridden && s.score !== null) nextCells[k(reg, id)] = fmt(s.score);
          } else nextCells[k(reg, id)] = s.absent ? 'AB' : s.score === null ? '' : fmt(s.score);
        }
      });

      const years = Array.from(new Set(students.map((s) => s.admissionYear)));
      const want = normCode(subject.code);
      const sessions: SessionDoc[] = [];
      for (const y of years) {
        const snap = await getDocs(query(collection(db, 'attendanceSessions'), where('admissionYear', '==', y)));
        snap.docs.forEach((d) => {
          const s = d.data() as SessionDoc;
          if (normCode(s.subjectCode) === want && subject.branches.includes(s.branch)) sessions.push(s);
        });
      }
      sessions.sort((a, b) => a.date.localeCompare(b.date) || (a.lecture ?? 1) - (b.lecture ?? 1));
      const ex = sessions.length ? await loadApprovedExcusals(regs) : { map: new Map<string, ExcusalRange[]>(), ok: true };
      const am = new Map<string, Att>();
      for (const st of students) {
        const rec = studentRecord(st, sessions.filter((d) => d.branch === st.branch && d.admissionYear === st.admissionYear), ex.map.get(st.regNo) ?? []);
        am.set(st.regNo, { attended: rec.attended, total: rec.total, pct: rec.total ? Math.round((rec.attended / rec.total) * 1000) / 10 : null });
      }

      setSaved(sv);
      setCols(nextCols);
      setCells(nextCells);
      setBands(bandPick?.bands?.length ? bandPick.bands : DEFAULT_BANDS);
      setAtt(am);
      setExcusalsOk(ex.ok);
      setAttOn(maxVotes.has(ATT));
      setEditBands(false);
      if (!sessions.length) setMsg({ kind: 'warn', text: `No attendance is recorded for ${subject.code} yet, so the Attendance column is empty. Upload or mark attendance first, or type the marks.` });
    } catch (e) {
      setMsg({ kind: 'err', text: `Couldn't load marks: ${(e as Error).message}` });
    } finally {
      setLoading(false);
    }
  }, [subject, students]);

  useEffect(() => {
    setAtt(null);
    setCols([]);
    setSaved(new Map());
    setCells({});
    if (subject && studentKey) load();
  }, [subject?.code, studentKey]);

  const attCol = cols.find((c) => c.id === ATT) ?? null;
  const sortedBands = useMemo(() => [...bands].sort((a, b) => b.min - a.min), [bands]);
  const bandProblem = useMemo(() => {
    const mins = bands.map((b) => b.min);
    if (new Set(mins).size !== mins.length) return 'Two ranges start at the same %.';
    if (!mins.includes(0)) return 'Add a range starting at 0% so every student gets a mark.';
    if (attCol && bands.some((b) => b.marks > attCol.max)) return `A range gives more than ${attCol.max}, the attendance maximum.`;
    return '';
  }, [bands, attCol]);

  const grid = useMemo(() => {
    const out = new Map<string, { value: number | null; absent: boolean; bad: boolean; dirty: boolean; clear: boolean; auto: number | null; overridden: boolean; blank: boolean }>();
    for (const st of students) {
      const sv = saved.get(st.regNo) ?? {};
      for (const c of cols) {
        const key = k(st.regNo, c.id);
        const raw = cells[key] ?? '';
        const s = sv[c.id];
        if (c.id === ATT) {
          const a = att?.get(st.regNo);
          const auto = a?.pct != null && !bandProblem ? marksFor(a.pct, bands) : null;
          const r = readMark(raw, c.max);
          const bad = r.kind === 'bad' || r.kind === 'absent';
          const typed = r.kind === 'num' ? r.value : null;
          const value = typed ?? auto;
          const overridden = typed !== null && typed !== auto;
          const dirty = attOn && !bad && value !== null && (!s || s.score !== value || s.max !== c.max || s.overridden !== overridden || s.absent);
          out.set(key, { value, absent: false, bad: attOn && bad, dirty, clear: false, auto, overridden, blank: value === null });
          continue;
        }
        const r = readMark(raw, c.max);
        if (r.kind === 'bad') {
          out.set(key, { value: null, absent: false, bad: true, dirty: false, clear: false, auto: null, overridden: false, blank: false });
          continue;
        }
        if (r.kind === 'blank') {
          out.set(key, { value: null, absent: false, bad: false, dirty: !!s, clear: !!s, auto: null, overridden: false, blank: true });
          continue;
        }
        const absent = r.kind === 'absent';
        const value = r.kind === 'num' ? r.value : null;
        const dirty = !s || s.max !== c.max || (absent ? !s.absent : s.absent || s.score !== value);
        out.set(key, { value, absent, bad: false, dirty, clear: false, auto: null, overridden: false, blank: false });
      }
    }
    return out;
  }, [students, cols, cells, saved, att, bands, bandProblem, attOn]);

  const stats = useMemo(() => {
    let dirty = 0;
    let bad = 0;
    const regs = new Set<string>();
    grid.forEach((g, key) => {
      if (g.bad) bad++;
      if (g.dirty) {
        dirty++;
        regs.add(key.split('|')[0]);
      }
    });
    return { dirty, bad, regs };
  }, [grid]);

  const totals = useMemo(() => {
    const m = new Map<string, { got: number; out: number }>();
    for (const st of students) {
      let got = 0;
      let out = 0;
      for (const c of cols) {
        if (c.id === ATT && !attOn) continue;
        const g = grid.get(k(st.regNo, c.id));
        if (!g || g.bad) continue;
        if (g.value !== null) {
          got += g.value;
          out += c.max;
        } else if (g.absent) out += c.max;
      }
      m.set(st.regNo, { got, out });
    }
    return m;
  }, [students, cols, grid, attOn]);

  const blocker = !subject
    ? 'Pick the semester and subject.'
    : !students.length
      ? 'No students on the list for this semester and subject.'
      : attOn && bandProblem
        ? `Attendance ranges: ${bandProblem}`
        : stats.bad
          ? `${stats.bad} mark${stats.bad === 1 ? ' is' : 's are'} more than the maximum or not a number (red boxes).`
          : !stats.dirty
            ? 'Nothing changed yet.'
            : '';

  const setCell = (reg: string, col: string, v: string) => setCells((m) => ({ ...m, [k(reg, col)]: v }));

  const addColumn = () => {
    if (!addId || cols.some((c) => c.id === addId)) return;
    const next = [...cols.filter((c) => c.id !== ATT), { id: addId, label: labelOf(addId), max: addMax }].sort((a, b) => orderOf(a.id) - orderOf(b.id));
    setCols([...next, ...(attCol ? [attCol] : [])]);
    setAddId('');
  };
  const removeColumn = (id: string) => {
    const hasSaved = students.some((s) => saved.get(s.regNo)?.[id]);
    if (hasSaved) {
      if (!confirm(`${labelOf(id)} already has published marks. Remove them for every student in this class when you publish?`)) return;
      setCells((m) => {
        const n = { ...m };
        students.forEach((s) => {
          n[k(s.regNo, id)] = '';
        });
        return n;
      });
      return;
    }
    setCols((cs) => cs.filter((c) => c.id !== id));
  };
  const setMax = (id: string, max: number) => setCols((cs) => cs.map((c) => (c.id === id ? { ...c, max } : c)));

  const onKey = (e: KeyboardEvent<HTMLInputElement>, r: number, c: number) => {
    const move = e.key === 'Enter' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (!move) return;
    e.preventDefault();
    const el = document.querySelector<HTMLInputElement>(`input[data-mb="${r + move}-${c}"]`);
    el?.focus();
    el?.select();
  };

  const fillFrom = (p: ParsedMarks) => {
    const inClass = new Set(students.map((s) => s.regNo.toUpperCase()));
    const regOf = new Map(students.map((s) => [s.regNo.toUpperCase(), s.regNo]));
    const used: { i: number; id: string; max: number }[] = [];
    const skipped: string[] = [];
    p.columns.forEach((c, i) => {
      const id = guessComponent(c.label);
      if (!id || used.some((u) => u.id === id)) skipped.push(c.label || `column ${i + 1}`);
      else used.push({ i, id, max: c.max ?? cols.find((x) => x.id === id)?.max ?? defMax(id) });
    });
    if (!used.length) {
      setMsg({ kind: 'err', text: `No marks columns recognised. Name the headers like "Quiz 1 (10)", "Mid sem (25)" or "Attendance (5)". Found: ${skipped.join(', ') || 'none'}.` });
      return;
    }
    const nextCols = [...cols];
    for (const u of used) {
      const at = nextCols.findIndex((c) => c.id === u.id);
      if (at === -1) nextCols.push({ id: u.id, label: labelOf(u.id), max: u.max });
      else nextCols[at] = { ...nextCols[at], max: u.max };
    }
    const ordered = nextCols.filter((c) => c.id !== ATT).sort((a, b) => orderOf(a.id) - orderOf(b.id));
    const att0 = nextCols.find((c) => c.id === ATT);
    setCols([...ordered, ...(att0 ? [att0] : [])]);
    let filled = 0;
    const outside: string[] = [];
    const next = { ...cells };
    for (const r of p.rows) {
      const reg = regOf.get(r.regNo.toUpperCase());
      if (!reg || !inClass.has(r.regNo.toUpperCase())) {
        outside.push(r.regNo);
        continue;
      }
      for (const u of used) {
        const v = String(r.values[u.i] ?? '').trim();
        if (!v) continue;
        next[k(reg, u.id)] = v;
        filled++;
      }
    }
    if (used.some((u) => u.id === ATT)) setAttOn(true);
    setCells(next);
    setMsg({
      kind: outside.length || skipped.length ? 'warn' : 'ok',
      text:
        `Filled ${filled} marks into ${used.map((u) => labelOf(u.id)).join(', ')}. Check them, then press Publish.` +
        (skipped.length ? ` Not used: ${skipped.join(', ')}.` : '') +
        (outside.length ? ` ${outside.length} enrollment number${outside.length === 1 ? ' is' : 's are'} not in this class: ${outside.slice(0, 8).join(', ')}${outside.length > 8 ? '…' : ''}.` : ''),
    });
  };

  const readFile = async (f: File) => {
    setMsg(null);
    try {
      if (/\.pdf$/i.test(f.name) || f.type === 'application/pdf') {
        const { getPdfjs } = await import('./timetableImport');
        const pdfjs = await getPdfjs();
        const pdf = await pdfjs.getDocument({ data: new Uint8Array(await f.arrayBuffer()) }).promise;
        const pages = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          const tc = await (await pdf.getPage(i)).getTextContent();
          pages.push(
            (tc.items as { str?: string; transform: number[]; width: number }[])
              .filter((it) => typeof it.str === 'string')
              .map((it) => ({ str: it.str as string, x: it.transform[4], y: it.transform[5], w: it.width })),
          );
        }
        if (pages.every((p) => p.length === 0)) {
          setMsg({ kind: 'err', text: 'This PDF is a scanned image, so it can’t be read. Use Excel instead.' });
          return;
        }
        const res = parseMarksPdf(pages);
        if ('error' in res) setMsg({ kind: 'err', text: res.error });
        else fillFrom(res);
        return;
      }
      const res = await readSheetRows(f, parseMarksGrid);
      if ('error' in res) setMsg({ kind: 'err', text: `${res.error} Tip: use "Download sheet" and fill that in.` });
      else fillFrom(res.result);
    } catch (e) {
      setMsg({ kind: 'err', text: `Couldn't read this file: ${(e as Error).message}` });
    } finally {
      setFileKey((x) => x + 1);
    }
  };

  const download = () => {
    if (!subject || !students.length) return;
    const shown = cols.filter((c) => c.id !== ATT || attOn);
    const extra = shown.length ? [] : [{ id: 'quiz-1', label: 'Quiz 1', max: 10 }];
    const all = [...shown, ...extra];
    const label = cls === ALL ? 'All' : classOptions.find((c) => c.key === cls)?.label ?? '';
    downloadXlsx(`Marks ${subject.code} ${label}.xlsx`.replace(/\s+/g, ' '), [
      {
        name: 'Marks',
        rows: [
          [`${subject.code} ${subject.name} · Semester ${semester} · ${label}`],
          [],
          ['Enrollment No.', 'Name', ...all.map((c) => `${c.label} (${c.max})`)],
          ...students.map((s) => [
            s.regNo,
            s.name,
            ...all.map((c) => {
              const g = grid.get(k(s.regNo, c.id));
              if (!g) return null;
              return g.absent ? 'AB' : g.value;
            }),
          ]),
        ],
        widths: [18, 34, ...all.map(() => 14)],
      },
      {
        name: 'How to fill',
        rows: [
          ['How to fill this sheet'],
          ['1. Type marks under each column. The number in brackets is the maximum.'],
          ['2. Write AB for absent. Leave a box empty to keep what is already published.'],
          ['3. Add a column like "Quiz 2 (10)" or "Assignment (10)" to upload more at once.'],
          ['4. Save, then use "Fill from Excel" on the Marks page and press Publish.'],
        ],
        widths: [110],
      },
    ]);
  };

  const publish = async () => {
    if (!subject || blocker) return;
    const changedCols = new Set<string>();
    grid.forEach((g, key) => g.dirty && changedCols.add(key.split('|')[1]));
    const names = Array.from(changedCols).map(labelOf).join(', ');
    if (!confirm(`Publish ${stats.dirty} change${stats.dirty === 1 ? '' : 's'} (${names}) for ${stats.regs.size} students of ${subject.code}?\n\nStudents ${notify ? 'get a notification and ' : ''}see them in the app.`)) return;
    setBusy(true);
    setMsg(null);
    try {
      const by = auth.currentUser;
      const list = students.filter((s) => stats.regs.has(s.regNo));
      for (let i = 0; i < list.length; i += 400) {
        const b = writeBatch(db);
        for (const st of list.slice(i, i + 400)) {
          const comps: Record<string, unknown> = {};
          for (const c of cols) {
            const g = grid.get(k(st.regNo, c.id));
            if (!g || !g.dirty) continue;
            if (g.clear) {
              comps[c.id] = deleteField();
              continue;
            }
            const a = c.id === ATT ? att?.get(st.regNo) : null;
            comps[c.id] = {
              label: c.label,
              max: c.max,
              score: g.absent ? null : g.value,
              absent: g.absent,
              ...(c.id === ATT ? { percent: a?.pct ?? null, auto: g.auto, overridden: g.overridden } : {}),
              updatedAt: serverTimestamp(),
            };
          }
          b.set(
            doc(db, 'marks', `${st.regNo}_${safe(subject.code)}`),
            {
              enrollmentNumber: st.regNo,
              studentName: st.name,
              branch: st.branch,
              section: st.section ?? null,
              admissionYear: st.admissionYear,
              semester: Number(semester),
              subjectCode: subject.code,
              subjectName: subject.name,
              components: comps,
              updatedAt: serverTimestamp(),
              updatedBy: by?.uid ?? null,
              updatedByName: by?.displayName ?? by?.email ?? 'Faculty',
            },
            { merge: true },
          );
        }
        await b.commit();
      }
      const clean = sortedBands.map((x) => ({ min: x.min, marks: x.marks }));
      await addDoc(collection(db, 'marksUploads'), {
        subjectCode: subject.code,
        subjectName: subject.name,
        semester: Number(semester),
        components: cols.filter((c) => changedCols.has(c.id)).map((c) => ({ id: c.id, label: c.label, max: c.max })),
        ...(changedCols.has(ATT) ? { attendanceBands: clean } : {}),
        regNos: list.map((s) => s.regNo),
        count: list.length,
        notify,
        fileName: 'Marks page',
        uploadedBy: by?.uid ?? null,
        uploadedByName: by?.displayName ?? by?.email ?? 'Faculty',
        createdAt: serverTimestamp(),
      });
      if (changedCols.has(ATT)) {
        try {
          localStorage.setItem(bandsKey(subject.code), JSON.stringify({ outOf: attCol?.max ?? 5, bands: clean }));
        } catch {
          setEditBands(false);
        }
      }
      await load();
      setMsg({ kind: 'ok', text: `Published ${names} for ${list.length} students.${notify ? ' They are being notified.' : ''}` });
    } catch (e) {
      setMsg({ kind: 'err', text: `Couldn't publish: ${(e as Error).message}. Nothing was lost — try again.` });
    } finally {
      setBusy(false);
    }
  };

  if (loadErr) return <div className="mb"><p className="mb-note err">{loadErr}</p></div>;

  const addable = COMPONENTS.filter((c) => c.id !== ATT && !cols.some((x) => x.id === c.id));
  const ready = !!subject && !!att && !loading;

  return (
    <div className="mb">
      <section className="mb-card">
        <div className="mb-head">
          <div>
            <h1>Marks</h1>
            <p>Every exam for your subject on one page. Type marks, fill them from Excel, and attendance marks are worked out for you. Only what you change is published.</p>
          </div>
        </div>
        <div className="mb-pick">
          <div className="mb-field">
            <label>Semester</label>
            <select value={semester} onChange={(e) => { setSemester(e.target.value); setCode(''); setCls(ALL); }}>
              <option value="">Pick…</option>
              {SEMS.map((n) => <option key={n} value={n}>Sem {n}</option>)}
            </select>
          </div>
          <div className="mb-field">
            <label>Subject</label>
            <select value={code} onChange={(e) => { setCode(e.target.value); setCls(ALL); }} disabled={!semester}>
              <option value="">{semester ? 'Pick the subject…' : 'Pick the semester first'}</option>
              {subjectOptions.map((s) => <option key={s.code} value={s.code}>{s.code} — {s.name}</option>)}
            </select>
          </div>
          <div className="mb-field">
            <label>Class</label>
            <select value={cls} onChange={(e) => setCls(e.target.value)} disabled={!subject || !classOptions.length}>
              <option value={ALL}>{subject ? `All students (${takers.length})` : '—'}</option>
              {classOptions.map((c) => <option key={c.key} value={c.key}>{c.label} ({c.count})</option>)}
            </select>
          </div>
        </div>
        {!roster && <p className="mb-hint" style={{ marginTop: '0.6rem' }}>Loading the student list…</p>}
        {subject && roster && !takers.length && <p className="mb-note warn" style={{ marginTop: '0.8rem' }}>No students on the list are in Sem {semester} for {subject.code}.</p>}
      </section>

      {subject && students.length > 0 && (
        <section className="mb-card">
          <div className="mb-bar">
            <strong>Attendance marks</strong>
            <label className="mb-check">
              <input type="checkbox" checked={attOn} onChange={(e) => setAttOn(e.target.checked)} /> Give marks for attendance
            </label>
            <span className="grow" />
            {attOn && (
              <button type="button" className="button-secondary" onClick={() => setEditBands((v) => !v)}>
                {editBands ? 'Done' : 'Change ranges'}
              </button>
            )}
          </div>
          {attOn && !editBands && (
            <div className="mb-ranges" style={{ marginTop: '0.7rem' }}>
              <span className="mb-hint">Out of {attCol?.max ?? 5}:</span>
              {sortedBands.map((b, i) => <span key={b.min} className="mb-chip">{rangeText(sortedBands, i)} → {b.marks}</span>)}
            </div>
          )}
          {attOn && editBands && (
            <>
              <div className="mb-bar" style={{ marginTop: '0.8rem' }}>
                <div className="mb-field" style={{ width: 150 }}>
                  <label>Out of</label>
                  <select value={attCol?.max ?? 5} onChange={(e) => setMax(ATT, Number(e.target.value))}>
                    {MAXES.filter((n) => n <= 20).map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
              </div>
              <table className="mb-band-table">
                <thead>
                  <tr><th style={{ width: 130 }}>From</th><th>Range</th><th style={{ width: 110 }}>Marks</th><th style={{ width: 90 }} /></tr>
                </thead>
                <tbody>
                  {sortedBands.map((b, si) => {
                    const i = bands.indexOf(b);
                    return (
                      <tr key={`${b.min}-${si}`}>
                        <td>
                          <select value={b.min} onChange={(e) => setBands((bs) => bs.map((x, j) => (j === i ? { ...x, min: Number(e.target.value) } : x)))}>
                            {PCTS.map((p) => <option key={p} value={p}>{p}%</option>)}
                          </select>
                        </td>
                        <td className="mb-range">{rangeText(sortedBands, si)}</td>
                        <td>
                          <select value={b.marks} onChange={(e) => setBands((bs) => bs.map((x, j) => (j === i ? { ...x, marks: Number(e.target.value) } : x)))}>
                            {Array.from({ length: (attCol?.max ?? 5) * 2 + 1 }, (_, n) => n / 2).map((m) => <option key={m} value={m}>{fmt(m)}</option>)}
                          </select>
                        </td>
                        <td>
                          <button type="button" className="button-secondary" onClick={() => setBands((bs) => bs.filter((_, j) => j !== i))} disabled={bands.length <= 1}>Remove</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="mb-bar" style={{ marginTop: '0.6rem' }}>
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => {
                    const free = PCTS.find((p) => !bands.some((b) => b.min === p));
                    if (free !== undefined) setBands((bs) => [...bs, { min: free, marks: 0 }]);
                  }}
                >
                  Add a range
                </button>
                <button type="button" className="button-secondary" onClick={() => setBands(DEFAULT_BANDS.map((b) => ({ ...b, marks: Math.min(b.marks, attCol?.max ?? 5) })))}>
                  Reset to 75 / 60 / 50 / 40
                </button>
              </div>
            </>
          )}
          {attOn && bandProblem && <p className="mb-note warn" style={{ marginTop: '0.7rem' }}>{bandProblem}</p>}
          {!attOn && <p className="mb-hint" style={{ marginTop: '0.5rem' }}>Turn this on to work out marks from each student's attendance percentage. You can still change any student's mark in the table.</p>}
          {attOn && !excusalsOk && <p className="mb-hint" style={{ marginTop: '0.5rem' }}>Approved event or medical-leave excusals couldn’t be read, so they count as absences.</p>}
        </section>
      )}

      {subject && students.length > 0 && (
        <section className="mb-card">
          <div className="mb-bar" style={{ marginBottom: '0.8rem' }}>
            <div className="mb-add">
              <select value={addId} onChange={(e) => { setAddId(e.target.value); setAddMax(defMax(e.target.value)); }} disabled={!ready}>
                <option value="">Add an exam column…</option>
                {addable.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
              <select className="mb-small" value={addMax} onChange={(e) => setAddMax(Number(e.target.value))} disabled={!addId}>
                {MAXES.map((n) => <option key={n} value={n}>/ {n}</option>)}
              </select>
              <button type="button" onClick={addColumn} disabled={!addId}>Add</button>
            </div>
            <span className="grow" />
            <button type="button" className="button-secondary" onClick={download} disabled={!ready}>Download sheet</button>
            <button type="button" className="button-secondary" onClick={() => fileRef.current?.click()} disabled={!ready}>Fill from Excel</button>
            <input key={fileKey} ref={fileRef} type="file" accept=".xlsx,.xls,.csv,.pdf" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) readFile(f); }} />
          </div>

          {msg && <p className={`mb-note ${msg.kind}`} style={{ marginBottom: '0.8rem' }}>{msg.text}</p>}
          {loading && <p className="mb-hint">Loading marks and attendance…</p>}

          {ready && (
            <>
              <div className="mb-grid-wrap">
                <table className="mb-grid">
                  <thead>
                    <tr>
                      <th className="mb-sticky">Enrollment</th>
                      <th className="mb-sticky2">Name</th>
                      {cols.map((c) =>
                        c.id === ATT ? (
                          attOn ? (
                            <th key={c.id} colSpan={2}>
                              <div className="mb-colhead att">
                                <span className="t">Attendance</span>
                                <span className="mb-sub">% · marks / {c.max}</span>
                              </div>
                            </th>
                          ) : null
                        ) : (
                          <th key={c.id}>
                            <div className="mb-colhead">
                              <span className="t">{c.label}</span>
                              <select value={c.max} onChange={(e) => setMax(c.id, Number(e.target.value))} aria-label={`${c.label} out of`}>
                                {Array.from(new Set([...MAXES, c.max])).sort((a, b) => a - b).map((n) => <option key={n} value={n}>/ {n}</option>)}
                              </select>
                              <button type="button" className="x" onClick={() => removeColumn(c.id)}>remove</button>
                            </div>
                          </th>
                        ),
                      )}
                      <th>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {students.map((st, ri) => {
                      const t = totals.get(st.regNo);
                      return (
                        <tr key={st.regNo}>
                          <td className="mb-sticky mb-reg">{st.regNo}</td>
                          <td className="mb-sticky2 mb-name" title={st.name}>{st.name}</td>
                          {cols.map((c, ci) => {
                            const g = grid.get(k(st.regNo, c.id));
                            if (c.id === ATT) {
                              if (!attOn) return null;
                              const a = att?.get(st.regNo);
                              return [
                                <td key={`${c.id}-p`} className="mb-num">
                                  <span className={`mb-pct${a?.pct != null && a.pct < 75 ? ' low' : ''}`}>{a?.pct == null ? '—' : `${fmt(a.pct)}%`}</span>
                                  <span className="mb-sub">{a?.total ? `${a.attended}/${a.total}` : 'no classes'}</span>
                                </td>,
                                <td key={c.id} className="mb-cell">
                                  <input
                                    className={`mb-in${g?.bad ? ' bad' : g?.dirty ? ' dirty' : ''}${g?.overridden ? ' over' : ''}`}
                                    data-mb={`${ri}-${ci}`}
                                    inputMode="decimal"
                                    value={cells[k(st.regNo, c.id)] ?? ''}
                                    placeholder={g?.auto == null ? '' : fmt(g.auto)}
                                    onChange={(e) => setCell(st.regNo, c.id, e.target.value)}
                                    onKeyDown={(e) => onKey(e, ri, ci)}
                                    title={g?.overridden ? `Range gives ${g.auto ?? '—'}; you typed a different mark. Clear the box to use the range.` : 'From the range. Type to change.'}
                                  />
                                </td>,
                              ];
                            }
                            return (
                              <td key={c.id} className="mb-cell">
                                <input
                                  className={`mb-in${g?.bad ? ' bad' : g?.dirty ? ' dirty' : ''}`}
                                  data-mb={`${ri}-${ci}`}
                                  inputMode="decimal"
                                  value={cells[k(st.regNo, c.id)] ?? ''}
                                  onChange={(e) => setCell(st.regNo, c.id, e.target.value)}
                                  onKeyDown={(e) => onKey(e, ri, ci)}
                                  title={g?.clear ? 'Will be removed when you publish' : undefined}
                                />
                              </td>
                            );
                          })}
                          <td className="mb-num mb-total">{t && t.out ? `${fmt(t.got)} / ${t.out}` : '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="mb-hint" style={{ marginTop: '0.5rem' }}>
                Type AB for absent. Enter or ↓ moves to the next student. Orange boxes are changes not published yet. A grey number in the attendance box comes from the range; type over it to give a different mark.
              </p>
              <div className="mb-foot">
                <label className="mb-check">
                  <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Notify students
                </label>
                <span className="grow mb-hint">{blocker || `${stats.dirty} change${stats.dirty === 1 ? '' : 's'} for ${stats.regs.size} student${stats.regs.size === 1 ? '' : 's'}`}</span>
                <button type="button" onClick={publish} disabled={busy || !!blocker}>
                  {busy ? 'Publishing…' : stats.dirty ? `Publish ${stats.dirty} change${stats.dirty === 1 ? '' : 's'}` : 'Publish'}
                </button>
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}
