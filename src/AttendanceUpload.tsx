import { useEffect, useMemo, useState } from 'react';
import AttendanceClassPicker, { type PickerState } from './AttendanceClassPicker';
import {
  dateWarnings,
  gridFromPdfPages,
  guessBlankMeaning,
  parseRegister,
  planRegister,
  prettyDate,
  semesterWindow,
  sessionDocId,
  todayIso,
  type ParsedRegister,
} from './attendanceCore';
import { existingIds, splitByBranch, writeSessions } from './attendanceData';
import { downloadXlsx } from './xlsxTemplates';

type Opts = { blank: 'present' | 'absent'; unknown: 'present' | 'absent'; missing: 'present' | 'absent' | 'skip' };

export default function AttendanceUpload() {
  const [ctx, setCtx] = useState<PickerState | null>(null);
  const [fileName, setFileName] = useState('');
  const [book, setBook] = useState<{ names: string[]; grids: Record<string, unknown[][]> } | null>(null);
  const [sheet, setSheet] = useState('');
  const [opts, setOpts] = useState<Opts>({ blank: 'present', unknown: 'present', missing: 'present' });
  const [guessed, setGuessed] = useState<'present' | 'absent' | null>(null);
  const [exclude, setExclude] = useState<Set<string>>(new Set());
  const [existing, setExisting] = useState<Set<string> | null>(null);
  const [onExisting, setOnExisting] = useState<'skip' | 'overwrite'>('skip');
  const [status, setStatus] = useState<{ kind: 'ok' | 'error' | 'info'; text: string } | null>(null);
  const [progress, setProgress] = useState<string>('');
  const [inputKey, setInputKey] = useState(0);
  const [fromPortal, setFromPortal] = useState(false);

  const ctxKey = ctx ? `${ctx.batch!.key}|${ctx.cls!.key}|${ctx.semester}|${ctx.subject?.code}|${ctx.specialization}` : '';

  const [sheetHours, setSheetHours] = useState(1);
  useEffect(() => {
    if (ctx?.subject) setSheetHours(/\b(lab|laboratory|workshop|practical)\b/i.test(ctx.subject.name) ? 2 : 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctxKey]);

  const yearFor = useMemo(() => {
    if (!ctx) return (m: number) => (m >= 7 ? new Date().getFullYear() : new Date().getFullYear());
    const w = semesterWindow(ctx.batch!.year, ctx.semester!);
    const y = Number(w.from.slice(0, 4));
    return (m: number) => (ctx.semester! % 2 === 1 ? (m >= 7 ? y : y + 1) : m <= 6 ? y : y - 1);
  }, [ctx]);

  const parsed: ParsedRegister | { error: string } | null = useMemo(() => {
    if (!book || !sheet || !ctx) return null;
    return parseRegister(book.grids[sheet] ?? [], yearFor);
  }, [book, sheet, ctx, yearFor]);
  const reg = parsed && !('error' in parsed) ? parsed : null;

  useEffect(() => {
    if (!reg) return;
    const g = guessBlankMeaning(reg);
    setGuessed(g);
    setOpts((o) => ({ ...o, blank: g }));
    setExclude(new Set());
  }, [reg]);

  const plan = useMemo(() => (reg && ctx ? planRegister(reg, opts, ctx.students, ctx.roster) : null), [reg, ctx, opts]);

  const flags = useMemo(() => {
    const m = new Map<string, { future: boolean; empty: boolean; notes: string[] }>();
    if (!plan || !ctx) return m;
    const win = semesterWindow(ctx.batch!.year, ctx.semester!);
    for (const s of plan.sessions) {
      m.set(`${s.date}#${s.lecture}`, {
        future: s.date > todayIso(),
        empty: s.empty,
        notes: dateWarnings(s.date, { holidays: ctx.holidays, window: win }),
      });
    }
    return m;
  }, [plan, ctx]);

  const idsFor = (date: string, lecture: number) =>
    ctx ? ctx.cls!.targets.map((t) => sessionDocId({ branch: t.branch, admissionYear: ctx.batch!.year, section: t.section, subjectCode: ctx.subject!.code, date, lecture })) : [];
  useEffect(() => {
    setExisting(null);
    if (!plan || !ctx?.subject) return;
    let live = true;
    const ids = plan.sessions.flatMap((s) => idsFor(s.date, s.lecture));
    existingIds(ids).then((found) => live && setExisting(found)).catch(() => live && setExisting(new Set()));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan?.sessions.length, ctxKey, sheet, fileName]);

  const already = (date: string, lecture: number) => !!existing && idsFor(date, lecture).some((id) => existing.has(id));

  const included = useMemo(() => {
    if (!plan) return [];
    return plan.sessions.filter((s) => {
      const k = `${s.date}#${s.lecture}`;
      const f = flags.get(k);
      if (exclude.has(k) || f?.future || f?.empty) return false;
      if (onExisting === 'skip' && already(s.date, s.lecture)) return false;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, flags, exclude, onExisting, existing]);

  const readFile = async (file: File) => {
    setStatus(null);
    setBook(null);
    setSheet('');
    setFileName(file.name);
    try {
      if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {

        const { getPdfjs } = await import('./timetableImport');
        const pdfjs = await getPdfjs();
        const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
        const pages = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          const tc = await (await pdf.getPage(i)).getTextContent();
          pages.push(
            (tc.items as any[])
              .filter((it) => typeof it.str === 'string')
              .map((it) => ({ str: it.str as string, x: it.transform[4] as number, y: it.transform[5] as number, w: it.width as number })),
          );
        }
        const grid = gridFromPdfPages(pages);
        if ('error' in grid) {
          setStatus({ kind: 'error', text: grid.error });
          return;
        }
        setFromPortal(false);
        setOnExisting('skip');
        setBook({ names: ['PDF'], grids: { PDF: grid } });
        setSheet('PDF');
        return;
      }
      const XLSX = await import('xlsx');
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', raw: true });
      const grids: Record<string, unknown[][]> = {};
      for (const n of wb.SheetNames) {
        grids[n] = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: null, blankrows: true });
      }
      const names = wb.SheetNames.filter((n) => grids[n].length > 0);
      if (!names.length) {
        setStatus({ kind: 'error', text: 'Every sheet in this file is empty.' });
        return;
      }
      setBook({ names, grids });

      const fromPortal = names.includes('Key') && names.includes('Summary');
      setOnExisting(fromPortal ? 'overwrite' : 'skip');
      setFromPortal(fromPortal);

      const flat = (x: string) => x.replace(/[\s_-]+/g, '').toLowerCase();
      const code = flat(ctx?.subject?.code ?? '');
      const label = flat(ctx?.cls?.section ?? '');
      setSheet(
        names.find((n) => code && flat(n) === code) ??
          names.find((n) => label && flat(n).includes(label)) ??
          names.find((n) => n !== 'Summary' && n !== 'Key') ??
          names[0],
      );
    } catch (e: any) {
      setStatus({ kind: 'error', text: `Couldn’t open this file (${e.message}). Save it as .xlsx from Excel or Google Sheets and try again.` });
    }
  };

  const upload = async () => {
    if (!ctx?.subject || !plan || !included.length) return;
    const overwriting = included.filter((s) => already(s.date, s.lecture)).length;
    if (
      !confirm(
        `Save ${included.length} class${included.length === 1 ? '' : 'es'} of ${ctx.subject.code} for ${ctx.cls!.label}?` +
          (overwriting ? `\n\n${overwriting} of them already had attendance saved — those will be replaced.` : ''),
      )
    )
      return;
    const docs = included.flatMap((s) =>
      splitByBranch(
        ctx.cls!,
        {
          admissionYear: ctx.batch!.year,
          subjectCode: ctx.subject!.code,
          subjectName: ctx.subject!.name,
          date: s.date,
          lecture: s.lecture,
          semester: ctx.semester!,
          specialization: ctx.specialization || null,
          hours: s.hours ?? sheetHours,
          kind: (s.hours ?? sheetHours) > 1 ? 'lab' : 'lecture',
          source: 'excel',
        },
        s.absent,
        s.excused,

        s.na.length ? ctx.students.filter((st) => !s.na.includes(st)) : ctx.students,
        s.na.length > 0,
      ),
    );
    setProgress(`Saving 0 of ${docs.length}…`);
    try {
      await writeSessions(docs, (n) => setProgress(`Saving ${n} of ${docs.length}…`));
      setStatus({ kind: 'ok', text: `Saved ${included.length} classes of ${ctx.subject.code}. Students see the updated percentage in the app now.` });
      setBook(null);
      setSheet('');
      setFileName('');
      setInputKey((k) => k + 1);
    } catch (e: any) {
      setStatus({ kind: 'error', text: `Saving stopped: ${e.message}. Classes saved before the error are kept — upload again to finish (choose “Skip” for already saved).` });
    } finally {
      setProgress('');
    }
  };

  const template = async () => {
    if (!ctx) return;
    const rows: (string | number | null)[][] = [
      ['Reg. No.', 'Name', '12/08/2026', '13/08/2026', '14/08/2026'],
      ...ctx.students.map((s) => [s.regNo, s.name, null, null, null]),
    ];
    await downloadXlsx(`Register_${(ctx.cls!.section ?? ctx.cls!.label).replace(/[^A-Za-z0-9]+/g, '-')}_${ctx.subject?.code ?? 'subject'}.xlsx`, [
      { name: 'Register', rows, widths: [14, 28, 12, 12, 12] },
      {
        name: 'How to fill',
        rows: [
          ['One column per class: put the date as the heading (12/08/2026, 12 Aug, or an Excel date).'],
          ['Two classes on the same day: use two columns with the same date (or write “12/08 L2”).'],
          ['Cells: P = present, A = absent, OD / ML = on duty or leave (counts as attended).'],
          ['Blank cells are fine — you choose on upload whether blank means present or absent.'],
          ['Extra columns like Total or % are ignored.'],
        ],
        widths: [100],
      },
    ]);
  };

  const sessionsShown = plan?.sessions ?? [];

  return (
    <div className="card att-card">
      <h1 style={{ fontSize: '1.5rem' }}>Upload old attendance (Excel)</h1>
      <p className="res-hint">
        For registers kept in Excel: one row per student, one column per class date, for one subject. You’ll see exactly what
        will be saved before anything is written.
      </p>

      <AttendanceClassPicker subjectMode="required" onChange={setCtx} />

      {ctx && (
        <>
          <div className="att-row" style={{ alignItems: 'flex-end' }}>
            <div className="att-field att-wide">
              <label>Register file (.xlsx, .xls, .csv or a PDF saved from Excel)</label>
              <input
                key={`${ctxKey}#${inputKey}`}
                type="file"
                accept=".xlsx,.xls,.csv,.pdf"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) readFile(f);
                }}
              />
            </div>
            <button type="button" className="button-secondary" onClick={template}>Get a blank register</button>
          </div>

          {book && book.names.length > 1 && (
            <div className="att-field" style={{ marginTop: '0.8rem' }}>
              <label>Sheet</label>
              <select value={sheet} onChange={(e) => setSheet(e.target.value)}>
                {book.names.map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </div>
          )}

          {fromPortal && book && (
            <p className="notice notice-ok">
              This is a register downloaded from the portal — the classes in it will replace what’s saved, so your edits
              in Excel become the record. Classes you deleted from the sheet are not deleted here (use Register for that).
            </p>
          )}
          {parsed && 'error' in parsed && <p className="notice notice-error">{parsed.error}</p>}

          {reg && plan && (
            <>
              <div className="att-summary">
                <div><strong>{plan.matched}</strong><span>students matched</span></div>
                <div><strong>{plan.sessions.length}</strong><span>class columns</span></div>
                <div><strong>{included.length}</strong><span>will be saved</span></div>
              </div>

              <div className="att-row">
                <div className="att-field">
                  <label>Blank cell means</label>
                  <select value={opts.blank} onChange={(e) => setOpts({ ...opts, blank: e.target.value as Opts['blank'] })}>
                    <option value="present">Present{guessed === 'present' ? ' (looks right for this sheet)' : ''}</option>
                    <option value="absent">Absent{guessed === 'absent' ? ' (looks right — sheet only marks P)' : ''}</option>
                  </select>
                </div>
                <div className="att-field">
                  <label>Students not in the sheet</label>
                  <select value={opts.missing} onChange={(e) => setOpts({ ...opts, missing: e.target.value as Opts['missing'] })}>
                    <option value="present">Count as present</option>
                    <option value="absent">Count as absent</option>
                    <option value="skip">Not in this class (other lab batch)</option>
                  </select>
                </div>
                <div className="att-field">
                  <label>Each class in this sheet is</label>
                  <select value={sheetHours} onChange={(e) => setSheetHours(Number(e.target.value))}>
                    <option value={1}>A lecture (1 hour)</option>
                    <option value={2}>A lab / workshop (2 hours)</option>
                    <option value={3}>A lab / workshop (3 hours)</option>
                  </select>
                </div>
                {plan.unknownValues.length > 0 && (
                  <div className="att-field">
                    <label>Other values ({plan.unknownValues.slice(0, 3).map((u) => `“${u.value}”`).join(', ')})</label>
                    <select value={opts.unknown} onChange={(e) => setOpts({ ...opts, unknown: e.target.value as Opts['unknown'] })}>
                      <option value="present">Count as present</option>
                      <option value="absent">Count as absent</option>
                    </select>
                  </div>
                )}
              </div>

              <div className="att-issues">
                {plan.missingFromSheet.length > 0 && (
                  <p className="notice att-warn">
                    {plan.missingFromSheet.length} student{plan.missingFromSheet.length === 1 ? ' is' : 's are'} in this class but not in the
                    sheet: {plan.missingFromSheet.slice(0, 8).map((s) => s.regNo).join(', ')}
                    {plan.missingFromSheet.length > 8 ? '…' : ''}.
                  </p>
                )}
                {plan.elsewhere.length > 0 && (
                  <p className="notice att-warn">
                    Skipped {plan.elsewhere.length} row{plan.elsewhere.length === 1 ? '' : 's'} of students from another class:{' '}
                    {plan.elsewhere.slice(0, 5).map((s) => `${s.regNo} (${s.where})`).join(', ')}
                    {plan.elsewhere.length > 5 ? '…' : ''}. Wrong sheet or wrong class picked?
                  </p>
                )}
                {plan.unknownRegs.length > 0 && (
                  <p className="notice att-warn">
                    Skipped {plan.unknownRegs.length} row{plan.unknownRegs.length === 1 ? '' : 's'} not in the roster:{' '}
                    {plan.unknownRegs.slice(0, 6).map((s) => s.regNo).join(', ')}
                    {plan.unknownRegs.length > 6 ? '…' : ''}.
                  </p>
                )}
                {plan.ambiguous.length > 0 && (
                  <p className="notice att-warn">
                    Couldn’t tell which student these short numbers mean: {plan.ambiguous.join(', ')} — use the full Reg. No. for them.
                  </p>
                )}
                {reg.duplicateRegs.length > 0 && (
                  <p className="notice att-warn">Listed twice (the lower row is used): {reg.duplicateRegs.join(', ')}.</p>
                )}
                {reg.skippedHeaders.length > 0 && (
                  <p className="res-hint">Ignored columns: {reg.skippedHeaders.join(', ')}.</p>
                )}
              </div>

              {existing && existing.size > 0 && (
                <div className="att-field" style={{ marginTop: '0.8rem' }}>
                  <label>Classes that already have attendance saved</label>
                  <select value={onExisting} onChange={(e) => setOnExisting(e.target.value as 'skip' | 'overwrite')}>
                    <option value="skip">Skip them (keep what’s saved)</option>
                    <option value="overwrite">Replace them with this sheet</option>
                  </select>
                </div>
              )}

              <div className="att-scroll">
                <table className="att-table">
                  <thead>
                    <tr>
                      <th style={{ width: 34 }} />
                      <th>Class</th>
                      <th>Present</th>
                      <th>Absent</th>
                      <th>OD</th>
                      <th>Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessionsShown.map((s) => {
                      const k = `${s.date}#${s.lecture}`;
                      const f = flags.get(k)!;
                      const isOld = already(s.date, s.lecture);
                      const blocked = f.future || f.empty || (isOld && onExisting === 'skip');
                      const on = !blocked && !exclude.has(k);
                      return (
                        <tr key={k} className={on ? '' : 'att-off'}>
                          <td>
                            <input
                              type="checkbox"
                              checked={on}
                              disabled={blocked}
                              onChange={(e) =>
                                setExclude((prev) => {
                                  const n = new Set(prev);
                                  if (e.target.checked) n.delete(k);
                                  else n.add(k);
                                  return n;
                                })
                              }
                              style={{ width: 'auto' }}
                            />
                          </td>
                          <td>
                            {prettyDate(s.date)} {s.date.slice(0, 4)}
                            {s.lecture > 1 ? ` · ${s.lecture}${['', 'st', 'nd', 'rd'][s.lecture] ?? 'th'} class` : ''}
                          </td>
                          <td>{s.present}</td>
                          <td title={s.absent.map((x) => x.regNo).join(', ')}>{s.absent.length}</td>
                          <td>{s.excused.length || ''}</td>
                          <td className="att-muted">
                            {[
                              f.future && 'future date — skipped',
                              f.empty && 'column is empty — skipped',
                              isOld && (onExisting === 'skip' ? 'already saved — skipped' : 'already saved — will replace'),
                              ...f.notes,
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <button type="button" onClick={upload} disabled={!!progress || !included.length || existing === null} style={{ width: '100%', marginTop: '1rem' }}>
                {progress ||
                  (existing === null
                    ? 'Checking what’s already saved…'
                    : included.length
                      ? `Save ${included.length} class${included.length === 1 ? '' : 'es'} of ${ctx.subject!.code}`
                      : 'Nothing to save')}
              </button>
            </>
          )}
        </>
      )}

      {status && (
        <p className={`notice ${status.kind === 'ok' ? 'notice-ok' : status.kind === 'error' ? 'notice-error' : ''}`}>{status.text}</p>
      )}
    </div>
  );
}
