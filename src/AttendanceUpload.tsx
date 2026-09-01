import { useState } from 'react';
import { doc, writeBatch, serverTimestamp } from 'firebase/firestore';
import { db, auth } from './firebaseConfig';

type StudentRow = {
  enrollmentNumber: string;
  name: string;
};

const HEADER_ALIASES = {
  enrollmentNumber: ['enrollmentnumber', 'enrollmentno', 'regno', 'regno.', 'rollno', 'registrationnumber'],
  name: ['name', 'studentname', 'fullname'],
};

function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[\s._/()-]/g, '');
}

function headerMatchesField(normalizedHeader: string, aliases: string[]): boolean {
  return aliases.some((alias) => normalizedHeader.includes(alias));
}

// Excel stores dates as either a JS Date object (if the workbook was read
// with cellDates:true), a serial day-number (days since 1899-12-30), or
// plain text — real exports use all three depending on how the original
// sheet was formatted, so all three need handling rather than assuming one.
function parseDateHeader(value: any): string | null {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }
  if (typeof value === 'number' && value > 20000 && value < 60000) {
    // Excel serial date: days since 1899-12-30
    const epoch = new Date(Date.UTC(1899, 11, 30));
    const date = new Date(epoch.getTime() + value * 86400000);
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    // Already in YYYY-MM-DD
    if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(trimmed)) {
      const [y, m, d] = trimmed.split('-').map(Number);
      return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
    // DD/MM/YYYY or DD-MM-YYYY (Indian convention, not US MM/DD/YYYY)
    const dmyMatch = trimmed.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    if (dmyMatch) {
      const [, d, m, y] = dmyMatch;
      return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }
    // "1 Sep 2026" / "1-Sep-2026" style
    const parsed = new Date(trimmed);
    if (!isNaN(parsed.getTime())) {
      return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(parsed.getDate()).padStart(2, '0')}`;
    }
  }
  return null;
}

// "P"/"Present"/"1"/"Y"/"Yes"/"✓" -> present. "A"/"Absent"/"0"/"N"/"No" ->
// absent. Anything else (including blank) defaults to present — matching
// the same "default present, exceptions only" philosophy the in-app
// marking screen uses, since wrongly marking someone absent from an
// ambiguous blank cell risks incorrectly flagging them below 75%, which
// is worse than the reverse.
function isMarkedAbsent(value: any): boolean {
  if (value === undefined || value === null || value === '') return false;
  const normalized = String(value).trim().toLowerCase();
  return ['a', 'absent', '0', 'n', 'no', 'false'].includes(normalized);
}

function AttendanceUpload() {
  const [branch, setBranch] = useState('');
  const [admissionYear, setAdmissionYear] = useState('');
  const [section, setSection] = useState('');
  const [subjectCode, setSubjectCode] = useState('');
  const [subjectName, setSubjectName] = useState('');

  const [status, setStatus] = useState('');
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<{
    dates: string[];
    students: StudentRow[];
    absentByDate: Record<string, string[]>;
    skippedColumns: string[];
  } | null>(null);

  const handleFile = async (file: File) => {
    if (!branch.trim() || !admissionYear.trim() || !subjectCode.trim() || !subjectName.trim()) {
      setStatus('Fill in Branch, Admission Year, Subject Code, and Subject Name first.');
      return;
    }
    setStatus('Reading file...');
    setPreview(null);
    const XLSX = await import('xlsx');
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: 'array', cellDates: true });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1 });

    if (rows.length < 2) {
      setStatus('This sheet appears to be empty.');
      return;
    }

    // Find the header row the same way Roster Upload does — scan the
    // first 10 rows for whichever one has recognizable Reg No / Name
    // columns, skipping any title row above it.
    let headerRowIndex = -1;
    let enrollmentCol = -1;
    let nameCol = -1;
    for (let i = 0; i < Math.min(rows.length, 10); i++) {
      const candidate = rows[i].map((h) => normalizeHeader(String(h ?? '')));
      const eCol = candidate.findIndex((h) => headerMatchesField(h, HEADER_ALIASES.enrollmentNumber));
      const nCol = candidate.findIndex((h) => headerMatchesField(h, HEADER_ALIASES.name));
      if (eCol !== -1 && nCol !== -1) {
        headerRowIndex = i;
        enrollmentCol = eCol;
        nameCol = nCol;
        break;
      }
    }

    if (headerRowIndex === -1) {
      setStatus('Could not find Reg No / Name columns in the first 10 rows.');
      return;
    }

    // Every other column in the header row is treated as a date column.
    const headerRow = rows[headerRowIndex];
    const dateColumns: { colIndex: number; date: string }[] = [];
    const skippedColumns: string[] = [];
    headerRow.forEach((cell, colIndex) => {
      if (colIndex === enrollmentCol || colIndex === nameCol || cell === undefined || cell === '') return;
      const parsed = parseDateHeader(cell);
      if (parsed) {
        dateColumns.push({ colIndex, date: parsed });
      } else {
        skippedColumns.push(String(cell));
      }
    });

    if (dateColumns.length === 0) {
      setStatus('No date columns could be recognized in the header row.');
      return;
    }

    const students: StudentRow[] = [];
    const absentByDate: Record<string, string[]> = {};
    dateColumns.forEach((d) => (absentByDate[d.date] = []));

    for (const row of rows.slice(headerRowIndex + 1)) {
      if (!row || row.every((c) => c === undefined || c === '')) continue;
      const enrollmentNumber = String(row[enrollmentCol] ?? '').trim().toUpperCase();
      const name = String(row[nameCol] ?? '').trim();
      if (!enrollmentNumber || !name) continue;
      students.push({ enrollmentNumber, name });

      for (const { colIndex, date } of dateColumns) {
        if (isMarkedAbsent(row[colIndex])) {
          absentByDate[date].push(enrollmentNumber);
        }
      }
    }

    setPreview({
      dates: dateColumns.map((d) => d.date).sort(),
      students,
      absentByDate,
      skippedColumns,
    });
    setStatus(
      `Parsed ${students.length} students across ${dateColumns.length} dates.` +
        (skippedColumns.length > 0 ? ` Skipped ${skippedColumns.length} unrecognized column(s) — see below.` : ''),
    );
  };

  const handleUpload = async () => {
    if (!preview) return;
    if (
      !confirm(
        `Write attendance for ${preview.dates.length} dates (${subjectCode.trim()}, ${branch.trim()} ${section.trim()})? This overwrites any existing record for the same class/subject/date combination.`,
      )
    )
      return;
    setUploading(true);
    setStatus('Uploading...');
    try {
      const markedBy = auth.currentUser?.uid ?? 'web-upload';
      // One doc per date, batched — well under Firestore's 500-write cap
      // for any realistic number of class dates in a single sheet.
      const batch = writeBatch(db);
      for (const date of preview.dates) {
        const id = `${branch.trim()}_${admissionYear.trim()}_${section.trim() || 'NONE'}_${subjectCode.trim()}_${date}`;
        const ref = doc(db, 'attendanceSessions', id);
        batch.set(ref, {
          branch: branch.trim(),
          admissionYear: Number(admissionYear.trim()),
          section: section.trim() || null,
          subjectCode: subjectCode.trim(),
          subjectName: subjectName.trim(),
          date,
          absentEnrollmentNumbers: preview.absentByDate[date],
          markedBy,
          markedAt: serverTimestamp(),
        });
      }
      await batch.commit();
      setStatus(`Uploaded attendance for ${preview.dates.length} dates.`);
      setPreview(null);
    } catch (err: any) {
      setStatus(`Upload failed: ${err.message}`);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="card" style={{ width: 680, padding: '2.5rem', margin: '3rem auto' }}>
      <h1 style={{ fontSize: '1.5rem' }}>Upload Attendance Register</h1>
      <p style={{ fontSize: '0.85rem', color: 'var(--ink-soft)' }}>
        For faculty who already keep a running Excel register (one row per student, one column per
        class date). Upload it here instead of re-entering it in the app — this covers one subject
        per upload.
      </p>

      <div style={{ display: 'flex', gap: '1rem', marginTop: '1.5rem' }}>
        <div style={{ flex: 1 }}>
          <label>Branch</label>
          <input type="text" value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="e.g. CSE" />
        </div>
        <div style={{ flex: 1 }}>
          <label>Admission Year</label>
          <input type="number" value={admissionYear} onChange={(e) => setAdmissionYear(e.target.value)} placeholder="e.g. 2025" />
        </div>
        <div style={{ flex: 1 }}>
          <label>Section</label>
          <input type="text" value={section} onChange={(e) => setSection(e.target.value)} placeholder="e.g. CSE B" />
        </div>
      </div>

      <div style={{ display: 'flex', gap: '1rem', marginTop: '1rem' }}>
        <div style={{ flex: 1 }}>
          <label>Subject Code</label>
          <input type="text" value={subjectCode} onChange={(e) => setSubjectCode(e.target.value)} placeholder="e.g. CS301" />
        </div>
        <div style={{ flex: 2 }}>
          <label>Subject Name</label>
          <input type="text" value={subjectName} onChange={(e) => setSubjectName(e.target.value)} placeholder="e.g. Database Management Systems" />
        </div>
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

      {preview && (
        <>
          {preview.skippedColumns.length > 0 && (
            <p style={{ fontSize: '0.8rem', color: '#b91c1c', marginTop: '0.5rem' }}>
              Unrecognized columns (ignored): {preview.skippedColumns.join(', ')}
            </p>
          )}

          <div style={{ maxHeight: 280, overflowY: 'auto', marginTop: '1rem', border: '1px solid var(--line)', borderRadius: 4 }}>
            {preview.dates.map((date) => (
              <div key={date} style={{ padding: '0.5rem 0.7rem', borderBottom: '1px solid var(--line)', fontSize: '0.85rem' }}>
                <strong>{date}</strong> — {preview.absentByDate[date].length} absent of {preview.students.length}
                {preview.absentByDate[date].length > 0 && (
                  <span style={{ color: 'var(--ink-soft)' }}> ({preview.absentByDate[date].join(', ')})</span>
                )}
              </div>
            ))}
          </div>

          <button onClick={handleUpload} disabled={uploading} style={{ width: '100%', marginTop: '1rem' }}>
            {uploading ? 'Uploading...' : `Upload Attendance for ${preview.dates.length} Dates`}
          </button>
        </>
      )}
    </div>
  );
}

export default AttendanceUpload;
