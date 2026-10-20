import { useEffect, useMemo, useState } from 'react';
import { doc, getDoc, setDoc, deleteDoc, serverTimestamp } from 'firebase/firestore';
import { db, auth } from './firebaseConfig';
import {
  EXAM_TYPES,
  examDocId,
  EXAM_BRANCH_CHOICES,
  branchesOf,
  isMultiBranch,
  parseExamRows,
  sortEntries,
  validateEntries,
} from './examSheetParser';
import type { ExamEntry, ExamTypeId } from './examSheetParser';
import { uploadExamSheetPdf } from './examPdf';
import ExamEditor from './ExamEditor';
import { examClassTemplate, readSheetRows } from './xlsxTemplates';

// MNC students are shown the CSE sheet in the student app (same rule the
// timetable already uses), so faculty only ever choose CSE, ECE, or —
// for exams both branches sit together for, which the real Sept 2026
// date sheet had several of (Computer Organization and Architecture,
// Programming for Problem Solving, ...) — Both, which publishes the
// exact same entries to both branches' sheets in one go instead of
// making faculty fill in and publish the identical rows twice.
const SEMESTERS = [1, 2, 3, 4, 5, 6, 7, 8] as const;

// One class at a time, from an Excel/CSV sheet or typed in by hand. The
// whole-college PDF upload lives in ExamPdfImport.tsx.
function ExamScheduleManual() {
  const [branch, setBranch] = useState('');
  const [semester, setSemester] = useState('');
  const [examType, setExamType] = useState<ExamTypeId | ''>('');

  const [entries, setEntries] = useState<ExamEntry[]>([]);
  const [problemRows, setProblemRows] = useState<number[]>([]);
  const [existing, setExisting] = useState(false);
  const [sourcePdf, setSourcePdf] = useState<{ url: string; name: string } | null>(null);
  const [attachFile, setAttachFile] = useState<File | null>(null);
  const [loadingExisting, setLoadingExisting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');

  const ready = !!branch && !!semester && !!examType;
  const examLabel = EXAM_TYPES.find((t) => t.id === examType)?.label ?? '';

  // Picking a class + exam type loads whatever is already published for it,
  // so the tab doubles as the correction tool (same idea as the Timetable
  // Editor) — no separate "edit" flow, just open it, fix a row, save again.
  useEffect(() => {
    setAttachFile(null);
    if (!ready) {
      setEntries([]);
      setExisting(false);
      setProblemRows([]);
      setSourcePdf(null);
      return;
    }
    // "Both" writes two separate docs, which could already hold two
    // DIFFERENT sheets (e.g. if this exam used to be branch-specific) —
    // there's no single "existing" version to load, so this is
    // publish-only for Both. Editing what's already published still
    // works, just pick CSE or ECE individually to do it.
    if (isMultiBranch(branch)) {
      setEntries([]);
      setExisting(false);
      setProblemRows([]);
      setSourcePdf(null);
      setStatus('A common exam writes the same rows to every branch you picked at once — to edit what\'s already published, select one branch instead.');
      return;
    }
    let cancelled = false;
    setLoadingExisting(true);
    setStatus('');
    getDoc(doc(db, 'examSchedules', examDocId(branch, Number(semester), examType)))
      .then((snap) => {
        if (cancelled) return;
        if (snap.exists()) {
          const data = snap.data();
          setEntries((data.entries ?? []) as ExamEntry[]);
          setSourcePdf(data.sourcePdfUrl ? { url: data.sourcePdfUrl, name: data.sourcePdfName ?? 'Official date sheet' } : null);
          setExisting(true);
          setStatus(`Loaded the published ${examLabel} date sheet — edit any row and save to update it.`);
        } else {
          setEntries([]);
          setSourcePdf(null);
          setExisting(false);
        }
        setProblemRows([]);
      })
      .catch((err) => !cancelled && setStatus(`Couldn't load existing date sheet: ${err.message}`))
      .finally(() => !cancelled && setLoadingExisting(false));
    return () => {
      cancelled = true;
    };
  }, [branch, semester, examType, ready, examLabel]);

  const handleFile = async (file: File) => {
    setStatus('Reading file...');
    try {
      const read = await readSheetRows(file, parseExamRows);
      if ('error' in read) {
        setStatus(read.error);
        return;
      }
      const parsed = read.result;
      setEntries(parsed.entries);
      setProblemRows(parsed.problemRows);
      setStatus(
        `Read ${parsed.entries.length} exam${parsed.entries.length === 1 ? '' : 's'} from "${file.name}"` +
          (parsed.problemRows.length ? ` — ${parsed.problemRows.length} need a date or time (highlighted below).` : '.') +
          ' Nothing is published until you press the Publish button.',
      );
    } catch (err: any) {
      setStatus(`Couldn't read this file: ${err.message ?? 'unknown error'}. Use .xlsx, .xls or .csv.`);
    }
  };

  // A real .xlsx, already listing this semester's subjects — faculty only
  // fill in dates and times, so codes and names can't be mistyped.
  const downloadTemplate = () => {
    examClassTemplate({ branch, semester: Number(semester), examLabel }).catch((e) =>
      setStatus(`Couldn't make the template: ${e.message}`),
    );
  };

  const validationError = useMemo(() => (entries.length ? validateEntries(entries) : null), [entries]);

  const handleSave = async () => {
    if (!ready) return;
    const err = validateEntries(entries);
    if (err) {
      setStatus(err);
      return;
    }
    const targetBranches = branchesOf(branch);
    const branchLabel = targetBranches.join(' and ');
    if (
      !confirm(
        `Publish the ${examLabel} date sheet for ${branchLabel} Semester ${semester} (${entries.length} exams)? Students in that semester get a notification.${existing ? ' This replaces the sheet that is already published.' : ''}`,
      )
    )
      return;

    setSaving(true);
    setStatus('Saving...');
    try {
      // Re-saving rows must not silently drop the attached PDF: keep the
      // one already on the sheet unless a new one was chosen.
      const pdf = attachFile ? await uploadExamSheetPdf(attachFile) : sourcePdf;
      const cleanEntries = sortEntries(entries).map((e) => ({
        date: e.date,
        startTime: e.startTime,
        endTime: e.endTime,
        subjectCode: e.subjectCode.trim().toUpperCase(),
        subjectName: e.subjectName.trim(),
        venue: e.venue.trim(),
      }));
      // Same entries, same attached PDF, written to each real branch's
      // OWN doc — Firestore never stores "BOTH" as a branch value, only
      // CSE and ECE, which is what every other screen already expects.
      // One after another, in order (see branchesOf).
      for (const b of targetBranches) {
        await setDoc(doc(db, 'examSchedules', examDocId(b, Number(semester), examType)), {
            branch: b,
            semester: Number(semester),
            examType,
            examTypeLabel: examLabel,
            entries: cleanEntries,
            ...(pdf ? { sourcePdfUrl: pdf.url, sourcePdfName: pdf.name } : {}),
            updatedAt: serverTimestamp(),
            updatedBy: auth.currentUser?.uid ?? 'web-portal',
            updatedByEmail: auth.currentUser?.email ?? '',
        });
      }
      setExisting(!isMultiBranch(branch));
      setSourcePdf(pdf);
      setAttachFile(null);
      setProblemRows([]);
      setStatus(`Published. Students in ${branchLabel} Semester ${semester} can see it in the app now.`);
    } catch (e: any) {
      setStatus(`Save failed: ${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!ready || !existing) return;
    if (!confirm(`Remove the published ${examLabel} date sheet for ${branch} Semester ${semester}? Students will no longer see it.`)) return;
    try {
      await deleteDoc(doc(db, 'examSchedules', examDocId(branch, Number(semester), examType)));
      setEntries([]);
      setSourcePdf(null);
      setExisting(false);
      setStatus('Removed.');
    } catch (e: any) {
      setStatus(`Couldn't remove it: ${e.message}`);
    }
  };

  return (
    <div>
      <p style={{ fontSize: '0.85rem', color: 'var(--ink-soft)' }}>
        For one class at a time: upload an Excel or CSV sheet (one row per exam) or type the rows in directly. Opening a
        class that is already published lets you correct it.
      </p>

      <div style={{ display: 'flex', gap: '1rem', marginTop: '1.25rem' }}>
        <div style={{ flex: 1 }}>
          <label>Branch</label>
          <select value={branch} onChange={(e) => setBranch(e.target.value)}>
            <option value="">Select...</option>
            {EXAM_BRANCH_CHOICES.map((b) => (
              <option key={b.value} value={b.value}>{b.label}</option>
            ))}
          </select>
        </div>
        <div style={{ flex: 1 }}>
          <label>Semester</label>
          <select value={semester} onChange={(e) => setSemester(e.target.value)}>
            <option value="">Select...</option>
            {SEMESTERS.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
        <div style={{ flex: 1 }}>
          <label>Exam</label>
          <select value={examType} onChange={(e) => setExamType(e.target.value as ExamTypeId)}>
            <option value="">Select...</option>
            {EXAM_TYPES.map((t) => (
              <option key={t.id} value={t.id}>{t.label}</option>
            ))}
          </select>
        </div>
      </div>

      {ready && (
        <>
          <div style={{ marginTop: '1.25rem', display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <div>
              <label>Upload date sheet (.xlsx, .xls, .csv)</label>
              <input
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleFile(f);
                  e.target.value = '';
                }}
              />
            </div>
            <button type="button" className="button-secondary" onClick={downloadTemplate} style={{ marginTop: '1.4rem' }}>
              Download Excel template
            </button>
          </div>
          <p style={{ fontSize: '0.78rem', color: 'var(--ink-soft)', marginTop: '0.5rem' }}>
            The template already lists this semester's subjects — just fill Date (DD/MM/YYYY), Start Time and End Time
            (10:00 or 1:00 PM), and Venue if known. Its second sheet, "How to fill", has the full rules.
          </p>

          <div style={{ marginTop: '0.75rem' }}>
            <label>Attach the official PDF (optional — students can open it from the app)</label>
            <input
              type="file"
              accept=".pdf,.jpg,.jpeg,.png"
              onChange={(e) => {
                setAttachFile(e.target.files?.[0] ?? null);
              }}
            />
            {sourcePdf && !attachFile && (
              <p style={{ fontSize: '0.8rem', margin: '0.3rem 0 0' }}>
                Currently attached:{' '}
                <a href={sourcePdf.url} target="_blank" rel="noreferrer">
                  {sourcePdf.name}
                </a>
              </p>
            )}
          </div>
        </>
      )}

      {status && <p style={{ marginTop: '1rem', fontSize: '0.9rem' }}>{status}</p>}
      {loadingExisting && <p style={{ fontSize: '0.85rem' }}>Checking for an existing date sheet...</p>}

      {ready && !loadingExisting && (
        <>
          <ExamEditor
            branch={branch}
            semester={semester}
            examType={examType}
            entries={entries}
            onChange={(next) => {
              setEntries(next);
              if (next.length !== entries.length) setProblemRows([]); // row numbers shifted
            }}
            problemRows={problemRows}
            onRowEdited={(n) => setProblemRows((prev) => prev.filter((r) => r !== n))}
          />

          {validationError && entries.length > 0 && (
            <p style={{ fontSize: '0.82rem', color: '#b45309', marginTop: '0.75rem' }}>{validationError}</p>
          )}

          <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1.5rem' }}>
            <button onClick={handleSave} disabled={saving || entries.length === 0 || !!validationError} style={{ flex: 1 }}>
              {saving ? 'Saving...' : existing ? `Update ${examLabel} Date Sheet` : `Publish ${examLabel} Date Sheet`}
            </button>
            {existing && (
              <button type="button" onClick={handleDelete} disabled={saving}>
                Remove
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export default ExamScheduleManual;
