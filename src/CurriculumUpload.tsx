import { useState } from 'react';
import { doc, writeBatch } from 'firebase/firestore';
import { db } from './firebaseConfig';

type CurriculumRow = {
  branch: string;
  semester: number;
  code: string;
  name: string;
};

const HEADER_ALIASES: Record<keyof CurriculumRow, string[]> = {
  branch: ['branch', 'department', 'dept'],
  semester: ['semester', 'sem'],
  code: ['code', 'coursecode', 'coursecodde'],
  name: ['name', 'course', 'coursename', 'subject', 'subjectname'],
};

function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[\s._-]/g, '');
}

function matchHeaders(headerRow: string[]): { mapping: Partial<Record<keyof CurriculumRow, number>>; missing: string[] } {
  const mapping: Partial<Record<keyof CurriculumRow, number>> = {};
  const normalizedHeaders = headerRow.map(normalizeHeader);

  (Object.keys(HEADER_ALIASES) as (keyof CurriculumRow)[]).forEach((field) => {
    const aliases = HEADER_ALIASES[field];
    const foundIndex = normalizedHeaders.findIndex((h) => aliases.includes(h));
    if (foundIndex !== -1) mapping[field] = foundIndex;
  });

  const missing = (Object.keys(HEADER_ALIASES) as (keyof CurriculumRow)[]).filter((f) => mapping[f] === undefined);
  return { mapping, missing };
}

function CurriculumUpload() {
  const [status, setStatus] = useState('');
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<CurriculumRow[]>([]);

  const handleFile = async (file: File) => {
    setStatus('Reading file...');
    const XLSX = await import('xlsx');
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: 'array' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1 });

    if (rows.length < 2) {
      setStatus('This sheet appears to be empty.');
      return;
    }

    const headerRow = rows[0].map((h) => String(h ?? ''));
    const { mapping, missing } = matchHeaders(headerRow);

    if (missing.length > 0) {
      setStatus(`Could not find columns for: ${missing.join(', ')}. Found headers were: ${headerRow.join(', ')}`);
      return;
    }

    const parsedRows: CurriculumRow[] = [];
    for (const row of rows.slice(1)) {
      if (!row || row.every((cell) => cell === undefined || cell === '')) continue;

      const branch = String(row[mapping.branch!] ?? '').trim().toUpperCase();
      const semester = Number(row[mapping.semester!]);
      const code = String(row[mapping.code!] ?? '').trim().toUpperCase();
      const name = String(row[mapping.name!] ?? '').trim();

      if (!branch || !code || !name || !semester) continue;

      parsedRows.push({ branch, semester, code, name });
    }

    setPreview(parsedRows);
    setStatus(`Parsed ${parsedRows.length} subjects. Review below, then upload.`);
  };

  const handleUploadToFirestore = async () => {
    if (preview.length === 0) return;
    if (
      !confirm(
        `Upload ${preview.length} subjects? Any existing subject sharing a branch+semester+code with one in this sheet will be overwritten with the new row's data.`,
      )
    )
      return;
    setUploading(true);
    setStatus('Uploading...');

    try {
      const chunkSize = 500;
      for (let i = 0; i < preview.length; i += chunkSize) {
        const chunk = preview.slice(i, i + chunkSize);
        const batch = writeBatch(db);
        chunk.forEach((subject) => {
          // One document per subject, ID built from branch+semester+code
          // so re-uploading a corrected sheet just overwrites, no dupes.
          const docId = `${subject.branch}_${subject.semester}_${subject.code}`;
          const ref = doc(db, 'curriculum', docId);
          batch.set(ref, subject);
        });
        await batch.commit();
      }
      setStatus(`Uploaded ${preview.length} subjects.`);
      setPreview([]);
    } catch (err: any) {
      setStatus(`Upload failed: ${err.message}`);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="card" style={{ width: 560, padding: '2.5rem', margin: '3rem auto' }}>
      <h1 style={{ fontSize: '1.5rem' }}>Upload Curriculum</h1>

      <div style={{ marginTop: '1.5rem' }}>
        <label>Excel file (.xlsx) — columns: Branch, Semester, Code, Name</label>
        <input
          type="file"
          accept=".xlsx,.xls"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
          }}
        />
      </div>

      {status && <p style={{ marginTop: '1rem', fontSize: '0.9rem' }}>{status}</p>}

      {preview.length > 0 && (
        <>
          <div style={{ maxHeight: 240, overflowY: 'auto', marginTop: '1rem', border: '1px solid var(--line)', borderRadius: 4 }}>
            {preview.slice(0, 10).map((row) => (
              <div key={`${row.branch}_${row.semester}_${row.code}`} className="list-row" style={{ padding: '0.4rem 0.7rem', borderBottom: '1px solid var(--line)', fontSize: '0.85rem' }}>
                {row.branch} · Sem {row.semester} · {row.code} — {row.name}
              </div>
            ))}
            {preview.length > 10 && (
              <div style={{ padding: '0.4rem 0.7rem', fontSize: '0.8rem', color: 'var(--ink-soft)' }}>
                ...and {preview.length - 10} more
              </div>
            )}
          </div>

          <button onClick={handleUploadToFirestore} disabled={uploading} style={{ width: '100%', marginTop: '1rem' }}>
            {uploading ? 'Uploading...' : `Upload ${preview.length} Subjects to Firestore`}
          </button>
        </>
      )}
    </div>
  );
}

export default CurriculumUpload;