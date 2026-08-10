import { useState } from 'react';
import { doc, writeBatch } from 'firebase/firestore';
import { db } from './firebaseConfig';

type RosterRow = {
  regNo: string;
  name: string;
  branch: string;
  section: string;
  admissionYear: number;
};

// Maps a bunch of possible real-world header spellings to the field we
// actually need. Lowercased and stripped of spaces/dots/underscores
// before comparing, so "Reg. No.", "reg_no", "Reg No" all match the same way.
const HEADER_ALIASES: Record<keyof RosterRow, string[]> = {
  regNo: ['regno', 'regno.', 'enrollmentnumber', 'enrollmentno', 'rollno', 'registrationnumber'],
  name: ['name', 'studentname', 'fullname'],
  branch: ['branch', 'department', 'dept'],
  section: ['section', 'sec'],
  admissionYear: ['admissionyear', 'yearofadmission', 'batch', 'batchyear', 'admnyear'],
};

function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[\s._-]/g, '');
}

// Given the raw header row from the spreadsheet, figures out which
// column index corresponds to each field we need.
function matchHeaders(headerRow: string[]): { mapping: Partial<Record<keyof RosterRow, number>>; missing: string[] } {
  const mapping: Partial<Record<keyof RosterRow, number>> = {};
  const normalizedHeaders = headerRow.map(normalizeHeader);

  (Object.keys(HEADER_ALIASES) as (keyof RosterRow)[]).forEach((field) => {
    const aliases = HEADER_ALIASES[field];
    const foundIndex = normalizedHeaders.findIndex((h) => aliases.includes(h));
    if (foundIndex !== -1) {
      mapping[field] = foundIndex;
    }
  });

  const missing = (Object.keys(HEADER_ALIASES) as (keyof RosterRow)[]).filter((f) => mapping[f] === undefined);
  return { mapping, missing };
}

function RosterUpload() {
  const [status, setStatus] = useState<string>('');
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<RosterRow[]>([]);

  const handleFile = async (file: File) => {
    setStatus('Reading file...');
    // Loaded on demand rather than imported at the top — xlsx is a large
    // library (~500KB+ minified), and someone only ever using the
    // Resources tab shouldn't have to download it at all.
    const XLSX = await import('xlsx');
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: 'array' });

    // Use the first sheet in the workbook.
    const firstSheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[firstSheetName];

    // header: 1 gives us an array-of-arrays (raw rows) instead of
    // guessing object keys itself — we need this so we can match
    // headers ourselves with our alias list.
    const rows: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1 });

    if (rows.length < 2) {
      setStatus('This sheet appears to be empty.');
      return;
    }

    const headerRow = rows[0].map((h) => String(h ?? ''));
    const { mapping, missing } = matchHeaders(headerRow);

    if (missing.length > 0) {
      setStatus(
        `Could not find columns for: ${missing.join(', ')}. Found headers were: ${headerRow.join(', ')}`
      );
      return;
    }

    const parsedRows: RosterRow[] = [];
    for (const row of rows.slice(1)) {
      if (!row || row.every((cell) => cell === undefined || cell === '')) continue; // skip blank rows

      const regNo = String(row[mapping.regNo!] ?? '').trim().toUpperCase();
      const name = String(row[mapping.name!] ?? '').trim();
      const branch = String(row[mapping.branch!] ?? '').trim().toUpperCase();
      const section = String(row[mapping.section!] ?? '').trim();
      const admissionYear = Number(row[mapping.admissionYear!]);

      if (!regNo || !name) continue; // skip incomplete rows

      parsedRows.push({ regNo, name, branch, section, admissionYear });
    }

    setPreview(parsedRows);
    setStatus(`Parsed ${parsedRows.length} students. Review below, then click Upload to Firestore.`);
  };

  const handleUploadToFirestore = async () => {
    if (preview.length === 0) return;
    // A bulk write like this silently overwrites any existing student
    // whose reg. no. matches one in the sheet (by design — see the
    // comment on `doc(db, 'roster', student.regNo)` below), which is a
    // much bigger, harder-to-undo action than filing one resource. That
    // deserves at least as much friction as the single-item delete
    // confirmation elsewhere in this app, not less.
    if (
      !confirm(
        `Upload ${preview.length} students to the roster? Any existing student sharing a reg. no. with one in this sheet will be overwritten with the new row's data.`,
      )
    )
      return;
    setUploading(true);
    setStatus('Uploading...');

    try {
      // Firestore batches cap at 500 writes each, so we chunk the list
      // into groups of 500 and send one batch per chunk.
      const chunkSize = 500;
      for (let i = 0; i < preview.length; i += chunkSize) {
        const chunk = preview.slice(i, i + chunkSize);
        const batch = writeBatch(db);
        chunk.forEach((student) => {
          // Using regNo AS the document ID means uploading the same
          // student twice just overwrites their existing entry, instead
          // of creating a duplicate.
          const ref = doc(db, 'roster', student.regNo);
          batch.set(ref, student);
        });
        await batch.commit();
      }
      setStatus(`Uploaded ${preview.length} students to the roster.`);
      setPreview([]);
    } catch (err: any) {
      setStatus(`Upload failed: ${err.message}`);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="card" style={{ width: 560, padding: '2.5rem', margin: '3rem auto' }}>
      <h1 style={{ fontSize: '1.5rem' }}>Upload Student Roster</h1>

      <div style={{ marginTop: '1.5rem' }}>
        <label>Excel file (.xlsx)</label>
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
              <div key={row.regNo} className="list-row" style={{ padding: '0.4rem 0.7rem', borderBottom: '1px solid var(--line)', fontSize: '0.85rem' }}>
                {row.regNo} — {row.name} — {row.branch} / {row.section} — {row.admissionYear}
              </div>
            ))}
            {preview.length > 10 && (
              <div style={{ padding: '0.4rem 0.7rem', fontSize: '0.8rem', color: 'var(--ink-soft)' }}>
                ...and {preview.length - 10} more
              </div>
            )}
          </div>

          <button onClick={handleUploadToFirestore} disabled={uploading} style={{ width: '100%', marginTop: '1rem' }}>
            {uploading ? 'Uploading...' : `Upload ${preview.length} Students to Firestore`}
          </button>
        </>
      )}
    </div>
  );
}

export default RosterUpload;