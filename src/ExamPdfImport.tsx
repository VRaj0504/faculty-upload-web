import { useEffect, useState } from 'react';
import { httpsCallable } from 'firebase/functions';
import { functions } from './firebaseConfig';
import { EXAM_SHEET_MAX_BYTES, fileToBase64, guessMimeType } from './examPdf';
import type { ExamGroup } from './examSheetParser';
import ExamSheetReview from './ExamSheetReview';

type ExtractResponse = { groups: ExamGroup[]; warnings: string[]; rowCount: number };

// Upload the college's date sheet exactly as the exam cell issues it (a
// scanned PDF covering every semester and branch) and get one editable
// draft per class back — no reformatting into a spreadsheet first.
function ExamPdfImport() {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [result, setResult] = useState<{ response: ExtractResponse; file: File } | null>(null);
  // Shows the actual picked file immediately, before extraction even
  // starts -- so faculty can already be looking at the real document
  // while the 20-40 second read happens, and keep it up afterward to
  // check extracted rows against it. A local object URL, not the
  // eventual Storage URL, since nothing's been uploaded yet at the
  // moment a file is picked.
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewMime, setPreviewMime] = useState<string>('');

  // Object URLs aren't freed automatically -- revoke the old one
  // whenever a new file is picked or this screen goes away, or each
  // pick leaks the previous file's blob for the rest of the tab's life.
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const handleFile = async (file: File) => {
    const mimeType = guessMimeType(file);
    if (!['application/pdf', 'image/jpeg', 'image/png'].includes(mimeType)) {
      setStatus('Upload a PDF, JPG or PNG of the date sheet.');
      return;
    }
    if (file.size > EXAM_SHEET_MAX_BYTES) {
      setStatus('That file is over 6.5 MB — compress the PDF (or rescan at lower quality) and try again.');
      return;
    }

    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(URL.createObjectURL(file));
    setPreviewMime(mimeType);

    setBusy(true);
    setResult(null);
    setStatus('Reading the date sheet — this usually takes 20 to 40 seconds...');
    try {
      const fileBase64 = await fileToBase64(file);
      const call = httpsCallable<{ fileBase64: string; mimeType: string; filename: string }, ExtractResponse>(
        functions,
        'extractExamSchedule',
      );
      const { data } = await call({ fileBase64, mimeType, filename: file.name });
      if (data.groups.length === 0) {
        setStatus(
          `No exams could be read from this file.${data.warnings.length ? ' ' + data.warnings.join(' ') : ''} Try the Excel / Manual tab instead.`,
        );
        return;
      }
      setResult({ response: data, file });
      setStatus(
        `Read ${data.rowCount} exams into ${data.groups.length} date sheet${data.groups.length === 1 ? '' : 's'}. Check them against the PDF, fix anything wrong, then publish.`,
      );
    } catch (err: any) {
      setStatus(`Couldn't read this file: ${err.message ?? 'unknown error'}. You can still use the Excel / Manual tab.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <p style={{ fontSize: '0.85rem', color: 'var(--ink-soft)' }}>
        Upload the date sheet PDF as issued — one file can cover every semester and branch, including the repeaters
        page. You review and edit every row before anything is published.
      </p>

      <div style={{ marginTop: '1rem' }}>
        <label>Date sheet (PDF, JPG or PNG)</label>
        <input
          type="file"
          accept=".pdf,.jpg,.jpeg,.png"
          disabled={busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
            e.target.value = '';
          }}
        />
      </div>

      {status && <p style={{ marginTop: '1rem', fontSize: '0.9rem' }}>{status}</p>}

      {previewUrl && (
        <div style={{ marginTop: '1rem' }}>
          <label style={{ display: 'block', marginBottom: '0.4rem' }}>Preview</label>
          {previewMime === 'application/pdf' ? (
            <iframe
              src={previewUrl}
              title="Date sheet preview"
              style={{ width: '100%', height: '70vh', border: '1px solid var(--rule, #e5e5e5)', borderRadius: 6 }}
            />
          ) : (
            <img
              src={previewUrl}
              alt="Date sheet preview"
              style={{ maxWidth: '100%', maxHeight: '70vh', border: '1px solid var(--rule, #e5e5e5)', borderRadius: 6 }}
            />
          )}
        </div>
      )}

      {result && (
        <ExamSheetReview
          key={result.file.name + result.file.size}
          initialGroups={result.response.groups}
          warnings={result.response.warnings}
          sourceFile={result.file}
          onPublished={(count) => {
            setResult(null);
            if (previewUrl) URL.revokeObjectURL(previewUrl);
            setPreviewUrl(null);
            setStatus(`Published ${count} date sheet${count === 1 ? '' : 's'}. Students in those semesters can see them in the app now.`);
          }}
        />
      )}
    </div>
  );
}

export default ExamPdfImport;
