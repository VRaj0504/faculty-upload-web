import { useState } from 'react';
import { doc, writeBatch } from 'firebase/firestore';
import { db } from './firebaseConfig';

type SubscriberRow = {
  enrollmentNumber: string;
  name: string;
};

const HEADER_ALIASES: Record<keyof SubscriberRow, string[]> = {
  enrollmentNumber: ['enrollmentnumber', 'enrollmentno', 'regno', 'regno.', 'rollno', 'registrationnumber'],
  name: ['name', 'studentname', 'fullname'],
};

function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[\s._/()-]/g, '');
}

function headerMatchesField(normalizedHeader: string, aliases: string[]): boolean {
  return aliases.some((alias) => normalizedHeader.includes(alias));
}

function matchHeaders(headerRow: string[]): { mapping: Partial<Record<keyof SubscriberRow, number>>; missing: string[] } {
  const mapping: Partial<Record<keyof SubscriberRow, number>> = {};
  const normalizedHeaders = headerRow.map(normalizeHeader);
  (Object.keys(HEADER_ALIASES) as (keyof SubscriberRow)[]).forEach((field) => {
    const idx = normalizedHeaders.findIndex((h) => headerMatchesField(h, HEADER_ALIASES[field]));
    if (idx !== -1) mapping[field] = idx;
  });
  const missing = (Object.keys(HEADER_ALIASES) as (keyof SubscriberRow)[]).filter((f) => mapping[f] === undefined);
  return { mapping, missing };
}

function currentMonthKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function MessSubscribersUpload() {
  const [status, setStatus] = useState('');
  const [uploading, setUploading] = useState(false);
  const [month, setMonth] = useState(currentMonthKey());
  const [preview, setPreview] = useState<SubscriberRow[]>([]);

  const handleFile = async (file: File) => {
    setStatus('Reading file...');
    setPreview([]);
    const XLSX = await import('xlsx');
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: 'array' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1 });

    if (rows.length < 2) {
      setStatus('This sheet appears to be empty.');
      return;
    }

    let headerRowIndex = -1;
    let mapping: Partial<Record<keyof SubscriberRow, number>> = {};
    for (let i = 0; i < Math.min(rows.length, 10); i++) {
      const candidate = rows[i].map((h) => String(h ?? ''));
      const result = matchHeaders(candidate);
      if (result.missing.length === 0) {
        headerRowIndex = i;
        mapping = result.mapping;
        break;
      }
    }

    if (headerRowIndex === -1) {
      setStatus('Could not find Enrollment Number and Name columns in the first 10 rows.');
      return;
    }

    const parsedRows: SubscriberRow[] = [];
    for (const row of rows.slice(headerRowIndex + 1)) {
      if (!row || row.every((cell) => cell === undefined || cell === '')) continue;
      const enrollmentNumber = String(row[mapping.enrollmentNumber!] ?? '').trim().toUpperCase();
      const name = String(row[mapping.name!] ?? '').trim();
      if (!enrollmentNumber || !name) continue;
      parsedRows.push({ enrollmentNumber, name });
    }

    setPreview(parsedRows);
    setStatus(`Parsed ${parsedRows.length} subscribers for ${month}. Review below, then click Upload.`);
  };

  const handleUpload = async () => {
    if (preview.length === 0) return;
    if (
      !confirm(
        `Mark ${preview.length} students as active Unlimited Thali subscribers for ${month}? This is the list students will be verified against at the canteen door.`,
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
        chunk.forEach((s) => {
          const ref = doc(db, 'messSubscriptions', `${s.enrollmentNumber}_${month}`);
          batch.set(ref, { enrollmentNumber: s.enrollmentNumber, name: s.name, month, active: true });
        });
        await batch.commit();
      }
      setStatus(`Uploaded ${preview.length} subscribers for ${month}.`);
      setPreview([]);
    } catch (err: any) {
      setStatus(`Upload failed: ${err.message}`);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="card" style={{ width: 640, padding: '2.5rem', margin: '3rem auto' }}>
      <h1 style={{ fontSize: '1.5rem' }}>Upload Thali Subscribers</h1>
      <p style={{ fontSize: '0.85rem', color: 'var(--ink-soft)' }}>
        Upload the monthly list of students who paid for Unlimited Thali. Needs just Enrollment
        Number and Name columns — any reasonable header names work.
      </p>

      <div style={{ marginTop: '1.5rem' }}>
        <label>Month this list is for</label>
        <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
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

      {preview.length > 0 && (
        <>
          <div style={{ maxHeight: 280, overflowY: 'auto', marginTop: '1rem', border: '1px solid var(--line)', borderRadius: 4 }}>
            {preview.slice(0, 15).map((row, i) => (
              <div key={`${row.enrollmentNumber}-${i}`} style={{ padding: '0.4rem 0.7rem', borderBottom: '1px solid var(--line)', fontSize: '0.85rem' }}>
                {row.enrollmentNumber} — {row.name}
              </div>
            ))}
            {preview.length > 15 && (
              <div style={{ padding: '0.4rem 0.7rem', fontSize: '0.8rem', color: 'var(--ink-soft)' }}>
                ...and {preview.length - 15} more
              </div>
            )}
          </div>

          <button onClick={handleUpload} disabled={uploading} style={{ width: '100%', marginTop: '1rem' }}>
            {uploading ? 'Uploading...' : `Upload ${preview.length} Subscribers for ${month}`}
          </button>
        </>
      )}
    </div>
  );
}

export default MessSubscribersUpload;
