import { useState } from 'react';
import { parseWholeCollegeExamRows } from './examSheetParser';
import { examWholeCollegeTemplate, readSheetRows } from './xlsxTemplates';
import type { ExamGroup } from './examSheetParser';
import ExamSheetReview from './ExamSheetReview';

// The no-AI equivalent of the whole-college PDF upload: one Excel/CSV
// sheet, every branch/semester/exam-type mixed together, split by row
// into however many separate date sheets it actually contains — same
// review-and-publish screen the PDF path uses (ExamSheetReview), so a
// correction here works exactly the same way it would after an AI
// extraction. Repeaters and supplementary exams often run on a
// completely different week than the exam they belong to; nothing
// here assumes otherwise, since every row carries its own dates.
function ExamWholeCollegeImport() {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [result, setResult] = useState<{ groups: ExamGroup[]; warnings: string[]; file: File } | null>(null);

  const handleFile = async (file: File) => {
    setBusy(true);
    setResult(null);
    setStatus('Reading file...');
    try {
      const read = await readSheetRows(file, parseWholeCollegeExamRows);
      if ('error' in read) {
        setStatus(read.error);
        return;
      }
      const parsed = read.result;

      const totalRows = parsed.groups.reduce((n, g) => n + g.entries.length, 0);
      setResult({ groups: parsed.groups, warnings: parsed.warnings, file });
      setStatus(
        `Read ${totalRows} exam${totalRows === 1 ? '' : 's'} across ${parsed.groups.length} date sheet${parsed.groups.length === 1 ? '' : 's'} from "${file.name}".` +
          (parsed.warnings.length ? ` ${parsed.warnings.length} row${parsed.warnings.length === 1 ? '' : 's'} need attention (below).` : '') +
          ' Nothing is published until you press Publish on each one.',
      );
    } catch (err: any) {
      setStatus(`Couldn't read this file: ${err.message ?? 'unknown error'}. Use .xlsx, .xls or .csv.`);
    } finally {
      setBusy(false);
    }
  };

  const downloadTemplate = () => {
    examWholeCollegeTemplate().catch((e) => setStatus(`Couldn't make the template: ${e.message}`));
  };

  return (
    <div>
      <p style={{ fontSize: '0.85rem', color: 'var(--ink-soft)' }}>
        One sheet for the entire college — every branch, semester and exam type in the same file, each row saying
        which class it belongs to. Splits automatically into however many separate date sheets it contains. No AI
        involved, so this works even while the Gemini billing issue is unresolved.
      </p>

      <div style={{ marginTop: '1rem', display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <div>
          <label>Upload whole-college sheet (.xlsx, .xls, .csv)</label>
          <input
            type="file"
            accept=".xlsx,.xls,.csv"
            disabled={busy}
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

      {status && <p style={{ marginTop: '1rem', fontSize: '0.9rem' }}>{status}</p>}

      {result && result.warnings.length > 0 && (
        <div style={{ marginTop: '1rem', padding: '1rem', background: '#FEF3C7', borderRadius: 6 }}>
          <strong style={{ fontSize: '0.85rem' }}>Rows that need a look:</strong>
          <ul style={{ fontSize: '0.8rem', marginTop: '0.4rem' }}>
            {result.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {result && (
        <div style={{ marginTop: '1.5rem' }}>
          <ExamSheetReview
            initialGroups={result.groups}
            warnings={[]}
            sourceFile={result.file}
            onPublished={(count) => {
              setResult(null);
              setStatus(`Published ${count} date sheet${count === 1 ? '' : 's'}. Students in those semesters can see them in the app now.`);
            }}
          />
        </div>
      )}
    </div>
  );
}

export default ExamWholeCollegeImport;
