import { useState } from 'react';
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { db, auth } from './firebaseConfig';
import { EXAM_BRANCH_CHOICES, EXAM_TYPES, branchesOf, examDocId } from './examSheetParser';
import type { ExamTypeId } from './examSheetParser';
import { guessMimeType, uploadExamSheetPdf } from './examPdf';

const SEMESTERS = [1, 2, 3, 4, 5, 6, 7, 8];
const MAX_BYTES = 15 * 1024 * 1024;

// The simple way: attach the date sheet exactly as issued. Nothing is read
// or converted — students open / download the file from the Exam Schedule
// screen in the app. One file can be attached to several semesters at once
// (the college PDF usually covers all of them). Rows already typed for a
// class are kept untouched.
function ExamPdfAttach() {
  const [branch, setBranch] = useState('');
  const [semesters, setSemesters] = useState<number[]>([]);
  const [examType, setExamType] = useState<ExamTypeId | ''>('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [ok, setOk] = useState(false);

  const examLabel = EXAM_TYPES.find((t) => t.id === examType)?.label ?? '';
  const ready = !!branch && semesters.length > 0 && !!examType && !!file;

  const toggle = (s: number) =>
    setSemesters((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s].sort((a, b) => a - b)));

  const pickFile = (f: File | null) => {
    setOk(false);
    if (!f) return setFile(null);
    const mime = guessMimeType(f);
    if (!['application/pdf', 'image/jpeg', 'image/png'].includes(mime)) {
      setFile(null);
      setStatus('Attach a PDF, JPG or PNG.');
      return;
    }
    if (f.size > MAX_BYTES) {
      setFile(null);
      setStatus('That file is over 15 MB — compress it and try again.');
      return;
    }
    setStatus('');
    setFile(f);
  };

  const publish = async () => {
    if (!ready || !file) return;
    const targets = branchesOf(branch);
    const where = `${targets.join(' & ')} · Semester ${semesters.join(', ')}`;
    if (!confirm(`Attach "${file.name}" as the ${examLabel} date sheet for ${where}? Students get a notification and can download it from the app.`))
      return;
    setBusy(true);
    setOk(false);
    setStatus('Uploading…');
    try {
      const pdf = await uploadExamSheetPdf(file);
      // Branch by branch, in order (MNC first — see branchesOf); the
      // semesters of one branch can go together.
      for (const b of targets) {
        await Promise.all(
          semesters.map(async (s) => {
            const ref = doc(db, 'examSchedules', examDocId(b, s, examType as ExamTypeId));
            const snap = await getDoc(ref);
            await setDoc(
              ref,
              {
                branch: b,
                semester: s,
                examType,
                examTypeLabel: examLabel,
                // A brand-new sheet has no rows (the rules need the field);
                // an existing one keeps whatever rows it already has.
                ...(snap.exists() ? {} : { entries: [] }),
                sourcePdfUrl: pdf.url,
                sourcePdfName: pdf.name,
                updatedAt: serverTimestamp(),
                updatedBy: auth.currentUser?.uid ?? 'web-portal',
                updatedByEmail: auth.currentUser?.email ?? '',
              },
              { merge: true },
            );
          }),
        );
      }
      setOk(true);
      setFile(null);
      setStatus(`Attached for ${where}. Students can download it from Exam Schedule in the app now.`);
    } catch (e: any) {
      setStatus(`Couldn't attach it: ${e.message ?? 'unknown error'}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <p style={{ fontSize: '0.85rem', color: 'var(--ink-soft)' }}>
        Attach the date sheet as it was issued. Students open and download the same file from the app — nothing is
        converted, so there is nothing to check. To also show day-by-day cards, add the rows in the other tabs.
      </p>

      <div style={{ display: 'flex', gap: '1rem', marginTop: '1.25rem', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 160 }}>
          <label>Branch</label>
          <select value={branch} onChange={(e) => setBranch(e.target.value)}>
            <option value="">Select...</option>
            {EXAM_BRANCH_CHOICES.map((b) => (
              <option key={b.value} value={b.value}>{b.label}</option>
            ))}
          </select>
        </div>
        <div style={{ flex: 1, minWidth: 160 }}>
          <label>Exam</label>
          <select value={examType} onChange={(e) => setExamType(e.target.value as ExamTypeId)}>
            <option value="">Select...</option>
            {EXAM_TYPES.map((t) => (
              <option key={t.id} value={t.id}>{t.label}</option>
            ))}
          </select>
        </div>
      </div>

      <div style={{ marginTop: '1rem' }}>
        <label>Semesters this file is for</label>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.35rem' }}>
          {SEMESTERS.map((s) => (
            <button
              key={s}
              type="button"
              className={semesters.includes(s) ? '' : 'button-secondary'}
              aria-pressed={semesters.includes(s)}
              onClick={() => toggle(s)}
              style={{ minWidth: 44, padding: '0.45rem 0.8rem' }}
            >
              {s}
            </button>
          ))}
          <button
            type="button"
            className="button-secondary"
            onClick={() => setSemesters(semesters.length === SEMESTERS.length ? [] : [...SEMESTERS])}
          >
            {semesters.length === SEMESTERS.length ? 'Clear' : 'All'}
          </button>
        </div>
      </div>

      <div style={{ marginTop: '1rem' }}>
        <label>Date sheet file (PDF, JPG or PNG)</label>
        <input
          type="file"
          accept=".pdf,.jpg,.jpeg,.png"
          disabled={busy}
          onChange={(e) => {
            pickFile(e.target.files?.[0] ?? null);
            e.target.value = '';
          }}
        />
        {file && (
          <p style={{ fontSize: '0.82rem', margin: '0.3rem 0 0' }}>
            {file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB
          </p>
        )}
      </div>

      <button onClick={publish} disabled={!ready || busy} style={{ marginTop: '1.25rem', width: '100%' }}>
        {busy ? 'Attaching…' : 'Attach for students'}
      </button>

      {status && (
        <p className={ok ? 'notice notice-ok' : undefined} style={{ marginTop: '1rem', fontSize: '0.9rem' }}>
          {status}
        </p>
      )}
    </div>
  );
}

export default ExamPdfAttach;
