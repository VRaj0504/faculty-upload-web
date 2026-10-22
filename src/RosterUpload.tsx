import { useState } from 'react';
import { doc, writeBatch } from 'firebase/firestore';
import { db } from './firebaseConfig';

type RosterRow = {
  regNo: string;
  name: string;
  branch: string;
  section: string;
  admissionYear: number;

  specialization?: string;

  program?: 'UG' | 'PG';
};

const REQUIRED_FIELDS: (keyof Pick<RosterRow, 'regNo' | 'name' | 'branch'>)[] = [
  'regNo',
  'name',
  'branch',
];

const HEADER_ALIASES: Record<keyof RosterRow, string[]> = {
  regNo: ['regno', 'regno.', 'enrollmentnumber', 'enrollmentno', 'rollno', 'registrationnumber'],
  name: ['name', 'studentname', 'fullname'],
  branch: ['branch', 'department', 'dept'],
  section: ['section', 'sec'],
  admissionYear: ['admissionyear', 'yearofadmission', 'batch', 'batchyear', 'admnyear'],
  specialization: ['specialization', 'specialisation', 'stream', 'track'],

  program: [],
};

function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[\s._/()-]/g, '');
}

function headerMatchesField(normalizedHeader: string, aliases: string[]): boolean {
  return aliases.some((alias) => normalizedHeader.includes(alias));
}

function matchHeaders(headerRow: string[]): { mapping: Partial<Record<keyof RosterRow, number>>; missing: string[] } {
  const mapping: Partial<Record<keyof RosterRow, number>> = {};
  const normalizedHeaders = headerRow.map(normalizeHeader);

  (Object.keys(HEADER_ALIASES) as (keyof RosterRow)[]).forEach((field) => {
    const aliases = HEADER_ALIASES[field];
    const foundIndex = normalizedHeaders.findIndex((h) => headerMatchesField(h, aliases));
    if (foundIndex !== -1) {
      mapping[field] = foundIndex;
    }
  });

  const missing = REQUIRED_FIELDS.filter((f) => mapping[f] === undefined);
  return { mapping, missing };
}

function classifyBranch(raw: string): { branch: string; specialization?: string } {
  const b = raw.trim();
  const lower = b.toLowerCase();
  if (lower.includes('mathematics and computing') || /\bmnc\b/i.test(b)) {
    return { branch: 'MNC' };
  }

  if (lower.includes('vlsi')) {
    return { branch: 'ECE', specialization: 'VLSI' };
  }
  if (lower.includes('defence and space') || lower.includes('defense and space')) {
    return { branch: 'ECE', specialization: 'Defence and Space Electronics' };
  }
  if (lower.includes('electronics and communication') || /\bece\b/i.test(b)) {
    return { branch: 'ECE' };
  }
  if (lower.includes('cyber security')) {
    return { branch: 'CSE', specialization: 'Cyber Security' };
  }

  if (lower.includes('data science')) {
    return { branch: 'CSE', specialization: 'Data Science and Artificial Intelligence' };
  }
  if (lower.includes('artificial intelligence') || lower.includes('machine learning')) {
    return { branch: 'CSE', specialization: 'AI/ML' };
  }
  if (lower.includes('computer science') || /\bcse\b/i.test(b)) {
    return { branch: 'CSE' };
  }
  return { branch: b.toUpperCase() };
}

function guessSectionFromSheetName(sheetName: string): string {
  return sheetName.replace(/[-_]+/g, ' ').trim().toUpperCase();
}

function titleCase(name: string): string {
  return name
    .toLowerCase()
    .split(' ')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

function yearFromRegNo(regNo: string): number | null {
  const m = /^(?:UG|PG)(\d{2})/i.exec(regNo.trim());
  return m ? 2000 + Number(m[1]) : null;
}

function inferProgram(regNo: string): 'UG' | 'PG' {
  return /^pg/i.test(regNo.trim()) ? 'PG' : 'UG';
}

type SheetParseResult = {
  sheetName: string;
  headerRowIndex: number;
  mapping: Partial<Record<keyof RosterRow, number>>;
  rows: any[][];
  error: string | null;
  included: boolean;
  sectionOverride: string;
};

const MAX_HEADER_SEARCH_ROWS = 10;

function parseSheet(sheetName: string, rawRows: any[][]): SheetParseResult {
  if (rawRows.length < 2) {
    return {
      sheetName,
      headerRowIndex: -1,
      mapping: {},
      rows: [],
      error: 'This sheet appears to be empty.',
      included: false,
      sectionOverride: guessSectionFromSheetName(sheetName),
    };
  }

  let headerRowIndex = -1;
  let mapping: Partial<Record<keyof RosterRow, number>> = {};
  let lastMissing: string[] = [];
  let lastHeaderRow: string[] = [];

  for (let i = 0; i < Math.min(rawRows.length, MAX_HEADER_SEARCH_ROWS); i++) {
    const candidate = rawRows[i].map((h) => String(h ?? ''));
    const result = matchHeaders(candidate);
    if (result.missing.length === 0) {
      headerRowIndex = i;
      mapping = result.mapping;
      break;
    }
    if (lastHeaderRow.length === 0 || result.missing.length < lastMissing.length) {
      lastMissing = result.missing;
      lastHeaderRow = candidate;
    }
  }

  if (headerRowIndex === -1) {
    return {
      sheetName,
      headerRowIndex: -1,
      mapping: {},
      rows: [],
      error: `Could not find columns for: ${lastMissing.join(', ')}. Closest match: ${lastHeaderRow.join(', ')}`,
      included: false,
      sectionOverride: guessSectionFromSheetName(sheetName),
    };
  }

  return {
    sheetName,
    headerRowIndex,
    mapping,
    rows: rawRows.slice(headerRowIndex + 1),
    error: null,
    included: true,
    sectionOverride: guessSectionFromSheetName(sheetName),
  };
}

function buildRowsForSheet(
  sheet: SheetParseResult,
  fallbackAdmissionYear: string,
): { rows: RosterRow[]; sectionMissing: boolean; yearMissing: boolean } {
  const needsManualSection = sheet.mapping.section === undefined;
  const needsManualYear = sheet.mapping.admissionYear === undefined;
  const sectionMissing = needsManualSection && !sheet.sectionOverride.trim();
  const yearMissing = needsManualYear && !Number(fallbackAdmissionYear);

  if (sectionMissing || yearMissing) {
    return { rows: [], sectionMissing, yearMissing };
  }

  const rows: RosterRow[] = [];
  for (const row of sheet.rows) {
    if (!row || row.every((cell) => cell === undefined || cell === '')) continue;

    const regNo = String(row[sheet.mapping.regNo!] ?? '').trim().toUpperCase();
    const name = String(row[sheet.mapping.name!] ?? '').trim();
    const rawBranch = String(row[sheet.mapping.branch!] ?? '').trim();
    if (!regNo || !name || !rawBranch) continue;

    const { branch, specialization: derivedSpecialization } = classifyBranch(rawBranch);
    const section = needsManualSection
      ? sheet.sectionOverride.trim()
      : String(row[sheet.mapping.section!] ?? '').trim();
    const admissionYear =
      yearFromRegNo(regNo) ??
      (needsManualYear ? Number(fallbackAdmissionYear) : Number(row[sheet.mapping.admissionYear!]));

    const columnSpecialization =
      sheet.mapping.specialization !== undefined
        ? String(row[sheet.mapping.specialization] ?? '').trim()
        : '';
    const specialization = columnSpecialization || derivedSpecialization || '';
    const program = inferProgram(regNo);

    rows.push({
      regNo,
      name: titleCase(name),
      branch,
      section,
      admissionYear,
      ...(specialization ? { specialization } : {}),
      ...(program === 'PG' ? { program } : {}),
    });
  }

  return { rows, sectionMissing: false, yearMissing: false };
}

function RosterUpload() {
  const [status, setStatus] = useState<string>('');
  const [uploading, setUploading] = useState(false);
  const [sheets, setSheets] = useState<SheetParseResult[]>([]);
  const [admissionYear, setAdmissionYear] = useState('');
  const [preview, setPreview] = useState<RosterRow[]>([]);

  const handleFile = async (file: File) => {
    setStatus('Reading file...');
    setPreview([]);

    const XLSX = await import('xlsx');
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: 'array' });

    const parsedSheets = workbook.SheetNames.map((sheetName) => {
      const sheet = workbook.Sheets[sheetName];
      const rawRows: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1 });
      return parseSheet(sheetName, rawRows);
    });

    setSheets(parsedSheets);
    const usable = parsedSheets.filter((s) => !s.error);
    const failed = parsedSheets.filter((s) => s.error);
    setStatus(
      failed.length === 0
        ? `Found ${usable.length} usable sheet(s). Review the section names below, then click Parse.`
        : `Found ${usable.length} usable sheet(s); ${failed.length} sheet(s) couldn't be read (see below) and will be skipped.`,
    );
  };

  const handleToggleSheet = (sheetName: string) => {
    setSheets((prev) =>
      prev.map((s) => (s.sheetName === sheetName ? { ...s, included: !s.included } : s)),
    );
  };

  const handleSectionOverrideChange = (sheetName: string, value: string) => {
    setSheets((prev) =>
      prev.map((s) => (s.sheetName === sheetName ? { ...s, sectionOverride: value } : s)),
    );
  };

  const handleParse = () => {
    const allRows: RosterRow[] = [];
    const problems: string[] = [];

    for (const sheet of sheets) {
      if (sheet.error || !sheet.included) continue;
      const { rows, sectionMissing, yearMissing } = buildRowsForSheet(sheet, admissionYear);
      if (sectionMissing) {
        problems.push(`"${sheet.sheetName}" has no Section column — fill in the Section field for it above.`);
        continue;
      }
      if (yearMissing) {
        problems.push(`"${sheet.sheetName}" has no Admission Year column — fill in the shared Admission Year field above.`);
        continue;
      }
      allRows.push(...rows);
    }

    if (problems.length > 0) {
      setStatus(problems.join(' '));
      return;
    }
    if (allRows.length === 0) {
      setStatus('No students to upload — check that at least one sheet is included and has data.');
      return;
    }

    setPreview(allRows);
    setStatus(`Parsed ${allRows.length} students across ${sheets.filter((s) => s.included && !s.error).length} sheet(s). Review below, then click Upload.`);
  };

  const handleUploadToFirestore = async () => {
    if (preview.length === 0) return;

    if (
      !confirm(
        `Upload ${preview.length} students to the roster? Any existing student sharing a reg. no. with one here will be updated with the new row's data.`,
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
        chunk.forEach((student) => {

          const ref = doc(db, 'roster', student.regNo);

          batch.set(ref, student, { merge: true });
        });
        await batch.commit();
      }
      setStatus(`Uploaded ${preview.length} students to the roster.`);
      setPreview([]);
      setSheets([]);
    } catch (err: any) {
      setStatus(`Upload failed: ${err.message}`);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="card" style={{ width: 640, padding: '2.5rem', margin: '3rem auto' }}>
      <h1 style={{ fontSize: '1.5rem' }}>Upload Student Roster</h1>
      <p style={{ fontSize: '0.85rem', color: 'var(--ink-soft)' }}>
        Works with almost any format — multiple sheets (one per section), full branch names
        instead of codes, and title rows before the real headers are all handled automatically.
      </p>

      <div style={{ marginTop: '1.5rem' }}>
        <label>Admission Year (only if none of your sheets have this column)</label>
        <input
          type="number"
          value={admissionYear}
          onChange={(e) => setAdmissionYear(e.target.value)}
          placeholder="e.g. 2026"
        />
      </div>

      <div style={{ marginTop: '1rem' }}>
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

      {sheets.length > 0 && (
        <div style={{ marginTop: '1rem' }}>
          {sheets.map((sheet) => (
            <div
              key={sheet.sheetName}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.6rem',
                padding: '0.5rem 0',
                borderBottom: '1px solid var(--line)',
                opacity: sheet.error ? 0.5 : 1,
              }}
            >
              <input
                type="checkbox"
                checked={sheet.included}
                disabled={!!sheet.error}
                onChange={() => handleToggleSheet(sheet.sheetName)}
                style={{ width: 'auto', flexShrink: 0 }}
              />
              <div style={{ flex: 1, fontSize: '0.85rem' }}>
                <strong>{sheet.sheetName}</strong>
                {sheet.error && <span style={{ color: 'var(--danger, #b91c1c)' }}> — {sheet.error}</span>}
              </div>
              {!sheet.error && sheet.mapping.section === undefined && (
                <input
                  type="text"
                  value={sheet.sectionOverride}
                  onChange={(e) => handleSectionOverrideChange(sheet.sheetName, e.target.value)}
                  placeholder="Section"
                  style={{ width: 110 }}
                />
              )}
            </div>
          ))}

          <button onClick={handleParse} style={{ width: '100%', marginTop: '1rem' }}>
            Parse Selected Sheets
          </button>
        </div>
      )}

      {preview.length > 0 && (
        <>
          <div style={{ maxHeight: 280, overflowY: 'auto', marginTop: '1rem', border: '1px solid var(--line)', borderRadius: 4 }}>
            {preview.slice(0, 15).map((row, i) => (
              <div key={`${row.regNo}-${i}`} className="list-row" style={{ padding: '0.4rem 0.7rem', borderBottom: '1px solid var(--line)', fontSize: '0.85rem' }}>
                {row.regNo} — {row.name} — {row.branch} / {row.section}
                {row.specialization ? ` (${row.specialization})` : ''} — {row.admissionYear}
                {row.program === 'PG' ? ' — PG' : ''}
              </div>
            ))}
            {preview.length > 15 && (
              <div style={{ padding: '0.4rem 0.7rem', fontSize: '0.8rem', color: 'var(--ink-soft)' }}>
                ...and {preview.length - 15} more
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
