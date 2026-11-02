import { useCallback, useEffect, useMemo, useState } from 'react';
import { addDoc, collection, doc, getDocs, query, serverTimestamp, where, writeBatch, type Timestamp } from 'firebase/firestore';
import { auth, db } from './firebaseConfig';
import { loadRoster, loadSubjectIndex, type RosterRow, type SubjectInfo } from './examData';
import { COMPONENTS, guessComponent, parseMarksGrid, parseMarksPdf, readMark, type ParsedMarks } from './marksImport';
import { downloadXlsx, readSheetRows } from './xlsxTemplates';

type Mapping = { comp: string; max: number };
type Upload = { id: string; subjectCode: string; subjectName: string; components: { label: string; max: number }[]; count: number; createdAt?: Timestamp | null };
const SEMS = [1, 2, 3, 4, 5, 6, 7, 8];
const safe = (c: string) => c.replace(/\s+/g, '').toUpperCase().replace(/\//g, '-');
const ALL = '__all__';

function currentSem(admissionYear: number, now = new Date()) {
  const isOdd = now.getMonth() >= 6;
  const idx = isOdd ? now.getFullYear() - admissionYear : now.getFullYear() - admissionYear - 1;
  return Math.min(8, Math.max(1, idx * 2 + 1 + (isOdd ? 0 : 1)));
}

const classKeyOf = (r: RosterRow) => `${r.branch}|${r.section ?? ''}|${r.admissionYear}`;
const classLabelOf = (r: RosterRow) => `${r.branch}${r.section ? ` · ${r.section}` : ''}`;

export default function UploadMarks() {
  const [roster, setRoster] = useState<RosterRow[] | null>(null);
  const [subjects, setSubjects] = useState<SubjectInfo[]>([]);
  const [loadErr, setLoadErr] = useState('');
  const [semester, setSemester] = useState('');
  const [code, setCode] = useState('');
  const [cls, setCls] = useState(ALL);
  const [exam, setExam] = useState('quiz-1');
  const [examMax, setExamMax] = useState(10);
  const [fileName, setFileName] = useState('');
  const [inputKey, setInputKey] = useState(0);
  const [parsed, setParsed] = useState<ParsedMarks | null>(null);
  const [err, setErr] = useState('');
  const [maps, setMaps] = useState<Mapping[]>([]);
  const [notify, setNotify] = useState(true);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');
  const [recent, setRecent] = useState<Upload[] | null>(null);

  useEffect(() => {
    Promise.all([loadRoster(), loadSubjectIndex()])
      .then(([r, idx]) => {
        setRoster(r);
        setSubjects(Array.from(idx.values()));
      })
      .catch((e) => setLoadErr(`Couldn't load the student list: ${e.message}`));
  }, []);

  const loadRecent = useCallback(async () => {
    const uid = auth.currentUser?.uid;
    if (!uid) return setRecent([]);
    try {
      const snap = await getDocs(query(collection(db, 'marksUploads'), where('uploadedBy', '==', uid)));
      const list = snap.docs
        .map((d) => ({ id: d.id, ...(d.data() as Omit<Upload, 'id'>) }))
        .sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0))
        .slice(0, 8);
      setRecent(list);
    } catch {
      setRecent([]);
    }
  }, []);

  useEffect(() => {
    loadRecent();
  }, [loadRecent]);

  const byReg = useMemo(() => new Map((roster ?? []).map((r) => [r.regNo.toUpperCase(), r])), [roster]);

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
      const k = classKeyOf(r);
      const hit = m.get(k);
      if (hit) hit.count++;
      else m.set(k, { key: k, label: classLabelOf(r), count: 1 });
    }
    return Array.from(m.values()).sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  }, [takers]);

  const classStudents = useMemo(
    () => (cls === ALL ? takers : takers.filter((r) => classKeyOf(r) === cls)).slice().sort((a, b) => a.regNo.localeCompare(b.regNo)),
    [takers, cls],
  );
  const classLabel = cls === ALL ? 'All students' : classOptions.find((c) => c.key === cls)?.label ?? '';

  useEffect(() => {
    setCls(ALL);
  }, [code, semester]);

  const reset = () => {
    setParsed(null);
    setErr('');
    setDone('');
  };

  const accept = (p: ParsedMarks | { error: string }) => {
    if ('error' in p) {
      setErr(p.error);
      return;
    }
    setParsed(p);
    if (!semester) {
      const regSem = (() => {
        for (const r of p.rows) {
          const st = byReg.get(r.regNo);
          if (st) return currentSem(st.admissionYear);
        }
        return null;
      })();
      const sem = p.semesterGuess ?? regSem;
      if (sem) setSemester(String(sem));
    }
    if (!code && p.codeGuess) setCode(p.codeGuess);
    const used = new Set<string>();
    setMaps(
      p.columns.map((c) => {
        let comp = guessComponent(c.label);
        if (!comp && p.columns.length === 1) comp = exam;
        if (comp && used.has(comp)) comp = '';
        if (comp) used.add(comp);
        const def = COMPONENTS.find((x) => x.id === comp);
        return { comp: comp || 'skip', max: c.max ?? (comp === exam ? examMax : def?.max ?? 10) };
      }),
    );
  };

  const readFile = async (f: File) => {
    reset();
    setFileName(f.name);
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
          setErr('This PDF is a scanned image, so it can’t be read. Use the Excel sheet instead (step 2).');
          return;
        }
        accept(parseMarksPdf(pages));
        return;
      }
      const res = await readSheetRows(f, parseMarksGrid);
      if ('error' in res) setErr(`${res.error} Tip: download the class sheet in step 2 and fill that in.`);
      else accept(res.result);
    } catch (e) {
      setErr(`Couldn't read this file: ${(e as Error).message}`);
    }
  };

  const plan = useMemo(() => {
    if (!parsed) return null;
    const active = maps.map((m, i) => ({ ...m, i })).filter((m) => m.comp !== 'skip');
    const unknown: string[] = [];
    const bad: string[] = [];
    let absent = 0;
    let blankStudents = 0;
    const seen = new Set<string>();
    const dupes: string[] = [];
    const rows = parsed.rows.map((r) => {
      const st = byReg.get(r.regNo) ?? null;
      if (!st) unknown.push(r.regNo);
      if (seen.has(r.regNo)) dupes.push(r.regNo);
      seen.add(r.regNo);
      const cells = active.map((m) => {
        const c = readMark(r.values[m.i] ?? '', m.max);
        if (c.kind === 'bad') bad.push(`${r.regNo}: "${c.raw}" in ${labelOf(m.comp)} (out of ${m.max})`);
        if (c.kind === 'absent') absent++;
        return c;
      });
      const empty = cells.every((c) => c.kind === 'blank');
      if (st && empty) blankStudents++;
      return { r, st, cells, empty };
    });
    const dupComp = active.map((m) => m.comp).filter((c, i, a) => a.indexOf(c) !== i);
    const inSheet = new Set(parsed.rows.map((r) => r.regNo));
    const missing = classStudents.filter((s) => !inSheet.has(s.regNo.toUpperCase()));
    const writable = rows.filter((x) => x.st && !x.empty);
    return { active, rows, unknown, bad, absent, dupes, dupComp, missing, blankStudents, writable };
  }, [parsed, maps, byReg, classStudents]);

  const blocker = !subject
    ? 'Pick the semester and subject in step 1.'
    : !plan?.active.length
      ? 'In "Columns in this sheet", choose what at least one column is (Quiz 1, Mid sem …).'
      : plan.dupComp.length
        ? `Two columns are set to ${labelOf(plan.dupComp[0])}. Change one of them.`
        : plan.bad.length
          ? 'Some marks are more than the "Out of" value (listed in red). Fix the sheet or change "Out of".'
          : !plan.writable.length
            ? 'No marks to publish: none of these students are on the student list, or their marks are blank.'
            : '';

  const publish = async () => {
    if (!plan || !subject || blocker) return;
    const labels = plan.active.map((m) => `${labelOf(m.comp)} (out of ${m.max})`).join(', ');
    if (
      !confirm(
        `Publish ${labels} for ${subject.code} ${subject.name} to ${plan.writable.length} students?` +
          (plan.unknown.length ? `\n\n${plan.unknown.length} enrollment numbers are not on the student list and will be skipped.` : '') +
          (plan.missing.length ? `\n\n${plan.missing.length} students of ${classLabel} are not in this sheet. Their marks stay as they are.` : '') +
          `\n\nStudents ${notify ? 'get a notification and ' : ''}see their marks in the app straight away. Uploading the same exam again replaces it.`,
      )
    )
      return;
    setBusy(true);
    setErr('');
    try {
      const by = auth.currentUser;
      const writes = plan.writable;
      for (let i = 0; i < writes.length; i += 400) {
        const b = writeBatch(db);
        for (const { st, cells } of writes.slice(i, i + 400)) {
          const comps: Record<string, unknown> = {};
          plan.active.forEach((m, k) => {
            const c = cells[k];
            if (c.kind === 'blank' || c.kind === 'bad') return;
            comps[m.comp] = {
              label: labelOf(m.comp),
              max: m.max,
              score: c.kind === 'num' ? c.value : null,
              absent: c.kind === 'absent',
              updatedAt: serverTimestamp(),
            };
          });
          b.set(
            doc(db, 'marks', `${st!.regNo}_${safe(subject.code)}`),
            {
              enrollmentNumber: st!.regNo,
              studentName: st!.name,
              branch: st!.branch,
              section: st!.section,
              admissionYear: st!.admissionYear,
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
      await addDoc(collection(db, 'marksUploads'), {
        subjectCode: subject.code,
        subjectName: subject.name,
        semester: Number(semester),
        components: plan.active.map((m) => ({ id: m.comp, label: labelOf(m.comp), max: m.max })),
        regNos: writes.map((x) => x.st!.regNo),
        count: writes.length,
        notify,
        fileName,
        uploadedBy: by?.uid ?? null,
        uploadedByName: by?.displayName ?? by?.email ?? 'Faculty',
        createdAt: serverTimestamp(),
      });
      setDone(`Done. ${labels} of ${subject.code} published for ${writes.length} students.${notify ? ' They are being notified now.' : ''}`);
      setParsed(null);
      setInputKey((k) => k + 1);
      loadRecent();
    } catch (e) {
      setErr(`Couldn't publish: ${(e as Error).message}. Nothing was lost — try again.`);
    } finally {
      setBusy(false);
    }
  };

  const downloadClassSheet = () => {
    if (!subject || !classStudents.length) return;
    const head = `${labelOf(exam)} (${examMax})`;
    const file = `Marks ${subject.code} ${labelOf(exam)} ${classLabel.replace(/[·\s]+/g, ' ').trim()}.xlsx`;
    downloadXlsx(file, [
      {
        name: 'Marks',
        rows: [
          [`${subject.code} ${subject.name} · Semester ${semester} · ${classLabel}`],
          [],
          ['Enrollment No.', 'Name', head],
          ...classStudents.map((s) => [s.regNo, s.name, null]),
        ],
        widths: [18, 34, 14],
      },
      {
        name: 'How to fill',
        rows: [
          ['How to fill this sheet'],
          [`1. Type each student's ${labelOf(exam)} marks in the "${head}" column, out of ${examMax}.`],
          ['2. Write AB for absent. Leave it empty if you don’t have the mark yet; it won’t be changed.'],
          ['3. Don’t change the enrollment numbers. You can add more columns like "Quiz 2 (10)" if you want to upload them together.'],
          ['4. Save the file and upload it in step 3 of Upload marks.'],
        ],
        widths: [110],
      },
    ]);
  };

  if (loadErr) return <div className="card att-card"><p className="notice notice-error">{loadErr}</p></div>;

  return (
    <div className="card att-card">
      <h1 style={{ fontSize: '1.5rem' }}>Upload marks</h1>
      <p className="res-hint">
        Three steps: pick your subject, download the class sheet with every student already listed, fill in the marks and upload it.
        Nothing is saved until you press Publish.
      </p>

      <h3 style={{ margin: '1.2rem 0 0.4rem' }}>1. Subject and class</h3>
      <div className="att-row">
        <div className="att-field att-narrow">
          <label>Semester</label>
          <select value={semester} onChange={(e) => { setSemester(e.target.value); setCode(''); }}>
            <option value="">Pick…</option>
            {SEMS.map((n) => <option key={n} value={n}>Sem {n}</option>)}
          </select>
        </div>
        <div className="att-field att-wide">
          <label>Subject{parsed?.titleGuess ? ` (sheet says: ${parsed.titleGuess}${parsed.codeGuess ? `, ${parsed.codeGuess}` : ''})` : ''}</label>
          <select value={code} onChange={(e) => setCode(e.target.value)} disabled={!semester}>
            <option value="">{semester ? 'Pick the subject…' : 'Pick the semester first'}</option>
            {subjectOptions.map((s) => <option key={s.code} value={s.code}>{s.code} — {s.name}</option>)}
          </select>
        </div>
        <div className="att-field att-narrow">
          <label>Class</label>
          <select value={cls} onChange={(e) => setCls(e.target.value)} disabled={!subject || !classOptions.length}>
            <option value={ALL}>{subject ? `All (${takers.length})` : '—'}</option>
            {classOptions.map((c) => <option key={c.key} value={c.key}>{c.label} ({c.count})</option>)}
          </select>
        </div>
      </div>
      {!roster && <p className="res-hint">Loading the student list…</p>}
      {subject && roster && !takers.length && (
        <p className="notice notice-warn">No students on the list are in Sem {semester} for {subject.code}. Check the semester.</p>
      )}

      <h3 style={{ margin: '1.2rem 0 0.4rem' }}>2. Get the class sheet</h3>
      <div className="att-row" style={{ alignItems: 'flex-end' }}>
        <div className="att-field">
          <label>Exam</label>
          <select
            value={exam}
            onChange={(e) => {
              setExam(e.target.value);
              setExamMax(COMPONENTS.find((x) => x.id === e.target.value)?.max ?? 10);
            }}
          >
            {COMPONENTS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
          </select>
        </div>
        <div className="att-field att-narrow">
          <label>Out of</label>
          <input type="number" min={1} max={300} value={examMax} onChange={(e) => setExamMax(Math.max(1, Math.min(300, Number(e.target.value) || 1)))} />
        </div>
        <button type="button" className="button-secondary" onClick={downloadClassSheet} disabled={!subject || !classStudents.length}>
          Download sheet{classStudents.length ? ` (${classStudents.length} students)` : ''}
        </button>
      </div>
      <p className="res-hint">Already have your own sheet? Skip this. Any Excel, CSV or PDF with enrollment numbers and marks works.</p>

      <h3 style={{ margin: '1.2rem 0 0.4rem' }}>3. Upload the filled sheet</h3>
      <div className="att-field att-wide">
        <input
          key={inputKey}
          type="file"
          accept=".xlsx,.xls,.csv,.pdf"
          disabled={!roster}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) readFile(f);
          }}
        />
      </div>
      {err && <p className="notice notice-error">{err}</p>}
      {done && <p className="notice notice-ok">{done}</p>}

      {parsed && plan && (
        <>
          <h3 style={{ margin: '1.2rem 0 0.4rem' }}>Columns in this sheet</h3>
          <table className="att-table">
            <thead>
              <tr><th>In the file</th><th>Save as</th><th style={{ width: 110 }}>Out of</th></tr>
            </thead>
            <tbody>
              {parsed.columns.map((c, i) => (
                <tr key={i}>
                  <td>{c.label}{c.max != null ? ` (${c.max})` : ''}</td>
                  <td>
                    <select
                      value={maps[i]?.comp ?? 'skip'}
                      onChange={(e) => {
                        const comp = e.target.value;
                        const def = COMPONENTS.find((x) => x.id === comp);
                        setMaps((m) => m.map((x, k) => (k === i ? { comp, max: c.max ?? def?.max ?? x.max } : x)));
                      }}
                    >
                      <option value="skip">Don't upload this column</option>
                      {COMPONENTS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
                    </select>
                  </td>
                  <td>
                    <input
                      type="number"
                      min={1}
                      max={300}
                      value={maps[i]?.max ?? 10}
                      onChange={(e) => {
                        const v = Math.max(1, Math.min(300, Number(e.target.value) || 1));
                        setMaps((m) => m.map((x, k) => (k === i ? { ...x, max: v } : x)));
                      }}
                      style={{ width: 90 }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="att-summary" style={{ marginTop: '1rem' }}>
            <div><strong>{plan.writable.length}</strong><span>will be published</span></div>
            <div><strong>{plan.absent}</strong><span>absent (AB)</span></div>
            <div><strong>{plan.blankStudents}</strong><span>blank, left unchanged</span></div>
            <div><strong>{plan.unknown.length}</strong><span>not on student list</span></div>
          </div>
          {plan.missing.length > 0 && (
            <p className="notice notice-warn">
              {plan.missing.length} student{plan.missing.length === 1 ? '' : 's'} of {classLabel} {plan.missing.length === 1 ? 'is' : 'are'} not in this sheet:{' '}
              {plan.missing.slice(0, 15).map((s) => s.regNo).join(', ')}{plan.missing.length > 15 ? ` … and ${plan.missing.length - 15} more` : ''}. Their marks stay as they are.
            </p>
          )}
          {plan.unknown.length > 0 && <p className="notice notice-warn">Skipped, not on the student list: {plan.unknown.join(', ')}</p>}
          {plan.dupes.length > 0 && <p className="notice notice-warn">Listed twice (the lower row is used): {Array.from(new Set(plan.dupes)).join(', ')}</p>}
          {plan.bad.length > 0 && <p className="notice notice-error">More than the "Out of" value: {plan.bad.slice(0, 12).join('; ')}{plan.bad.length > 12 ? ` … and ${plan.bad.length - 12} more` : ''}</p>}

          <div style={{ maxHeight: 420, overflow: 'auto', marginTop: '0.8rem' }}>
            <table className="att-table">
              <thead>
                <tr>
                  <th>Enrollment</th>
                  <th>Name</th>
                  {plan.active.map((m) => <th key={m.comp}>{labelOf(m.comp)} ({m.max})</th>)}
                </tr>
              </thead>
              <tbody>
                {[...plan.rows].sort((x, y) => Number(!x.st) - Number(!y.st)).map(({ r, st, cells }, i) => (
                  <tr key={`${r.regNo}-${i}`} className={st ? '' : 'att-off'}>
                    <td>{r.regNo}</td>
                    <td>{st?.name ?? r.name}{!st ? ' — not on student list' : ''}</td>
                    {cells.map((c, k) => (
                      <td key={k} style={c.kind === 'bad' ? { color: '#C1272D', fontWeight: 700 } : undefined}>
                        {c.kind === 'num' ? c.value : c.kind === 'absent' ? 'AB' : c.kind === 'bad' ? c.raw : '—'}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <label className="med-remember" style={{ marginTop: '1rem' }}>
            <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Notify students in the app
          </label>
          {blocker && <p className="res-hint" style={{ color: '#b45309' }}>{blocker}</p>}
          <button type="button" onClick={publish} disabled={busy || !!blocker} style={{ width: '100%', marginTop: '0.8rem' }}>
            {busy ? 'Publishing…' : `Publish marks to ${plan.writable.length} students`}
          </button>
        </>
      )}

      <h3 style={{ margin: '1.6rem 0 0.4rem' }}>Your recent uploads</h3>
      {recent === null ? (
        <p className="res-hint">Loading…</p>
      ) : recent.length === 0 ? (
        <p className="res-hint">Nothing uploaded yet.</p>
      ) : (
        <table className="att-table">
          <thead>
            <tr><th>When</th><th>Subject</th><th>Exam</th><th>Students</th></tr>
          </thead>
          <tbody>
            {recent.map((u) => (
              <tr key={u.id}>
                <td>{u.createdAt?.toDate ? u.createdAt.toDate().toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : 'Just now'}</td>
                <td>{u.subjectCode} — {u.subjectName}</td>
                <td>{(u.components ?? []).map((c) => `${c.label} (${c.max})`).join(', ')}</td>
                <td>{u.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="res-hint">Made a mistake? Fix the sheet and upload the same exam again; it replaces the old marks.</p>
    </div>
  );
}

function labelOf(id: string) {
  return COMPONENTS.find((x) => x.id === id)?.label ?? id;
}
