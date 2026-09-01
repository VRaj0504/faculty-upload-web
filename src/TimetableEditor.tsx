import { useState } from 'react';
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { ref, uploadBytes } from 'firebase/storage';
import { httpsCallable } from 'firebase/functions';
import { db, storage, functions, auth } from './firebaseConfig';

type TimetableSlot = {
  id: string;
  startTime: string;
  endTime: string;
  subjectCode: string;
  subjectName: string;
  faculty: string;
  room: string;
  group?: string;
};

type TimetableDay = {
  day: string;
  slots: TimetableSlot[];
};

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

// Must match src/firebase/timetableService.ts's timetableDocId() in the
// mobile app exactly — same three pieces, same order, same separator.
function timetableDocId(branch: string, semester: number, section: string): string {
  return `${branch}-${semester}-${section}`;
}

function emptySlot(): TimetableSlot {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    startTime: '',
    endTime: '',
    subjectCode: '',
    subjectName: '',
    faculty: '',
    room: '',
  };
}

function emptyWeek(): TimetableDay[] {
  return WEEKDAYS.map((day) => ({ day, slots: [] }));
}

function TimetableEditor() {
  const [branch, setBranch] = useState('');
  const [semester, setSemester] = useState('');
  const [section, setSection] = useState('');
  const [days, setDays] = useState<TimetableDay[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const [existed, setExisted] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importRawText, setImportRawText] = useState('');
  const [showImportRawText, setShowImportRawText] = useState(false);

  const handleImportFromPhoto = async (file: File) => {
    if (!days) {
      setStatus('Load a section first (Branch/Semester/Section above), then import a photo into it.');
      return;
    }
    setImporting(true);
    setStatus('Reading the timetable photo…');
    try {
      const storagePath = `timetableScans/${auth.currentUser?.uid ?? 'unknown'}/${Date.now()}.jpg`;
      const fileRef = ref(storage, storagePath);
      await uploadBytes(fileRef, file, {contentType: file.type || 'image/jpeg'});

      const extractTimetableInfo = httpsCallable<
        {storagePath: string; bucket: string},
        {rawText: string; slots: {day: string; startTime: string; endTime: string; rawText: string}[]}
      >(functions, 'extractTimetableInfo');

      const bucket = import.meta.env.VITE_FIREBASE_STORAGE_BUCKET as string;
      const result = await extractTimetableInfo({storagePath, bucket});
      const {rawText, slots} = result.data;
      setImportRawText(rawText);

      if (slots.length === 0) {
        setStatus(
          'Could not confidently detect the day/time grid in this photo — the full scanned text is available below to transcribe from manually.',
        );
        setShowImportRawText(true);
        return;
      }

      // Best-effort only — this replaces whatever's currently in the
      // editor with the scan's guesses, on the assumption this is being
      // used to start a fresh timetable from a new emailed photo, not to
      // patch an existing one. Every cell still needs to be checked
      // against the actual photo before saving; nothing here is trusted
      // as final.
      const next: TimetableDay[] = WEEKDAYS.map((day) => ({
        day,
        slots: slots
          .filter((s) => s.day === day)
          .map((s) => ({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            startTime: s.startTime,
            endTime: s.endTime,
            subjectCode: '',
            subjectName: s.rawText,
            faculty: '',
            room: '',
          })),
      }));
      setDays(next);
      setStatus(
        `Imported a rough first pass from the photo — go through every cell below and fix/split the text before saving. This is approximate, not exact.`,
      );
      setShowImportRawText(true);
    } catch (err: any) {
      setStatus(`Import failed: ${err.message}`);
    } finally {
      setImporting(false);
    }
  };

  const handleLoad = async () => {
    if (!branch.trim() || !semester.trim() || !section.trim()) {
      setStatus('Fill in Branch, Semester, and Section first.');
      return;
    }
    setLoading(true);
    setStatus('');
    try {
      const id = timetableDocId(branch.trim().toUpperCase(), Number(semester), section.trim());
      const snap = await getDoc(doc(db, 'timetable', id));
      if (snap.exists()) {
        const data = snap.data();
        // Ensure every weekday is present even if the existing doc is
        // missing one (e.g. it only ever had Mon-Thu filled in) — editing
        // should never lose the ability to add a day that was empty
        // before.
        const existingDays: TimetableDay[] = data.days ?? [];
        const merged = WEEKDAYS.map(
          (day) => existingDays.find((d) => d.day === day) ?? { day, slots: [] },
        );
        setDays(merged);
        setExisted(true);
        setStatus(`Loaded the existing timetable for ${id} — edit below, then save.`);
      } else {
        setDays(emptyWeek());
        setExisted(false);
        setStatus(`No existing timetable for ${id} yet — starting blank.`);
      }
    } catch (err: any) {
      setStatus(`Couldn't load: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleAddSlot = (dayIndex: number) => {
    if (!days) return;
    const next = [...days];
    next[dayIndex] = { ...next[dayIndex], slots: [...next[dayIndex].slots, emptySlot()] };
    setDays(next);
  };

  const handleRemoveSlot = (dayIndex: number, slotId: string) => {
    if (!days) return;
    const next = [...days];
    next[dayIndex] = { ...next[dayIndex], slots: next[dayIndex].slots.filter((s) => s.id !== slotId) };
    setDays(next);
  };

  const handleSlotChange = (dayIndex: number, slotId: string, field: keyof TimetableSlot, value: string) => {
    if (!days) return;
    const next = [...days];
    next[dayIndex] = {
      ...next[dayIndex],
      slots: next[dayIndex].slots.map((s) => (s.id === slotId ? { ...s, [field]: value } : s)),
    };
    setDays(next);
  };

  // Sorts each day's slots by start time before saving — the editor lets
  // you add slots in any order, but the mobile app's TimetableScreen
  // renders whatever order they're stored in, so this keeps the display
  // correctly chronological regardless of entry order here.
  const handleSave = async () => {
    if (!days) return;
    const id = timetableDocId(branch.trim().toUpperCase(), Number(semester), section.trim());
    if (
      !confirm(
        `Save this as the timetable for ${id}? This ${existed ? 'replaces the existing schedule for this section' : 'creates a new schedule'} entirely.`,
      )
    )
      return;

    setSaving(true);
    setStatus('Saving...');
    try {
      const sortedDays = days.map((d) => ({
        day: d.day,
        slots: [...d.slots]
          .filter((s) => s.startTime && s.subjectCode) // drop genuinely blank rows
          .sort((a, b) => a.startTime.localeCompare(b.startTime)),
      }));
      await setDoc(doc(db, 'timetable', id), {
        branch: branch.trim().toUpperCase(),
        semester: Number(semester),
        section: section.trim(),
        days: sortedDays,
        updatedAt: serverTimestamp(),
      });
      setStatus(`Saved. Students in ${branch.trim().toUpperCase()} Sem ${semester} ${section.trim()} will see this immediately.`);
      setExisted(true);
    } catch (err: any) {
      setStatus(`Save failed: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card" style={{ width: 760, padding: '2.5rem', margin: '3rem auto' }}>
      <h1 style={{ fontSize: '1.5rem' }}>Edit Timetable</h1>
      <p style={{ fontSize: '0.85rem', color: 'var(--ink-soft)' }}>
        Load a section's current schedule and edit just what changed — much faster than
        re-entering the whole week every time the timetable shifts.
      </p>

      <div style={{ display: 'flex', gap: '1rem', marginTop: '1.5rem' }}>
        <div style={{ flex: 1 }}>
          <label>Branch</label>
          <input type="text" value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="e.g. CSE" />
        </div>
        <div style={{ flex: 1 }}>
          <label>Semester</label>
          <input type="number" value={semester} onChange={(e) => setSemester(e.target.value)} placeholder="e.g. 3" />
        </div>
        <div style={{ flex: 1 }}>
          <label>Section</label>
          <input type="text" value={section} onChange={(e) => setSection(e.target.value)} placeholder="e.g. CSE A" />
        </div>
      </div>

      <button onClick={handleLoad} disabled={loading} style={{ width: '100%', marginTop: '1rem' }}>
        {loading ? 'Loading...' : 'Load This Section'}
      </button>

      {days && (
        <div style={{ marginTop: '1rem' }}>
          <label>Import from a timetable photo (optional — approximate, always review before saving)</label>
          <input
            type="file"
            accept="image/*"
            disabled={importing}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleImportFromPhoto(file);
            }}
          />
          {importRawText && (
            <div style={{ marginTop: '0.5rem' }}>
              <button
                onClick={() => setShowImportRawText((v) => !v)}
                className="button-secondary"
                style={{ fontSize: '0.8rem' }}
              >
                {showImportRawText ? 'Hide' : 'Show'} full scanned text
              </button>
              {showImportRawText && (
                <pre
                  style={{
                    marginTop: '0.5rem',
                    padding: '0.75rem',
                    background: 'var(--panel-bg, #f5f5f5)',
                    borderRadius: 6,
                    fontSize: '0.75rem',
                    whiteSpace: 'pre-wrap',
                    maxHeight: 200,
                    overflowY: 'auto',
                  }}
                >
                  {importRawText}
                </pre>
              )}
            </div>
          )}
        </div>
      )}

      {status && <p style={{ marginTop: '1rem', fontSize: '0.9rem' }}>{status}</p>}

      {days && (
        <>
          {days.map((dayData, dayIndex) => (
            <div key={dayData.day} style={{ marginTop: '1.5rem' }}>
              <h3 style={{ fontSize: '1rem', marginBottom: '0.5rem' }}>{dayData.day}</h3>

              {dayData.slots.map((slot) => (
                <div
                  key={slot.id}
                  style={{
                    display: 'flex',
                    gap: '0.4rem',
                    alignItems: 'center',
                    marginBottom: '0.4rem',
                    fontSize: '0.8rem',
                  }}
                >
                  <input
                    type="text"
                    value={slot.startTime}
                    onChange={(e) => handleSlotChange(dayIndex, slot.id, 'startTime', e.target.value)}
                    placeholder="9:00"
                    style={{ width: 60 }}
                  />
                  <input
                    type="text"
                    value={slot.endTime}
                    onChange={(e) => handleSlotChange(dayIndex, slot.id, 'endTime', e.target.value)}
                    placeholder="10:00"
                    style={{ width: 60 }}
                  />
                  <input
                    type="text"
                    value={slot.subjectCode}
                    onChange={(e) => handleSlotChange(dayIndex, slot.id, 'subjectCode', e.target.value)}
                    placeholder="CS301"
                    style={{ width: 80 }}
                  />
                  <input
                    type="text"
                    value={slot.subjectName}
                    onChange={(e) => handleSlotChange(dayIndex, slot.id, 'subjectName', e.target.value)}
                    placeholder="Subject name"
                    style={{ flex: 1 }}
                  />
                  <input
                    type="text"
                    value={slot.faculty}
                    onChange={(e) => handleSlotChange(dayIndex, slot.id, 'faculty', e.target.value)}
                    placeholder="Faculty"
                    style={{ width: 70 }}
                  />
                  <input
                    type="text"
                    value={slot.room}
                    onChange={(e) => handleSlotChange(dayIndex, slot.id, 'room', e.target.value)}
                    placeholder="Room"
                    style={{ width: 70 }}
                  />
                  <input
                    type="text"
                    value={slot.group ?? ''}
                    onChange={(e) => handleSlotChange(dayIndex, slot.id, 'group', e.target.value)}
                    placeholder="Group (opt.)"
                    style={{ width: 90 }}
                  />
                  <button
                    onClick={() => handleRemoveSlot(dayIndex, slot.id)}
                    className="button-secondary"
                    style={{ padding: '0.2rem 0.5rem' }}
                  >
                    ✕
                  </button>
                </div>
              ))}

              <button onClick={() => handleAddSlot(dayIndex)} className="button-secondary" style={{ fontSize: '0.8rem' }}>
                + Add class
              </button>
            </div>
          ))}

          <button onClick={handleSave} disabled={saving} style={{ width: '100%', marginTop: '1.5rem' }}>
            {saving ? 'Saving...' : 'Save Timetable'}
          </button>
        </>
      )}
    </div>
  );
}

export default TimetableEditor;
