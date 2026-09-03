import { useState, useEffect } from 'react';
import { doc, getDoc, setDoc, serverTimestamp, collection, getDocs } from 'firebase/firestore';
import { ref, uploadBytes } from 'firebase/storage';
import { httpsCallable } from 'firebase/functions';
import { db, storage, functions, auth } from './firebaseConfig';
import {
  parseSpreadsheetFile,
  renderPdfFirstPageToJpegBlob,
  parseAnySpreadsheetAllSections,
  renderAllPdfPagesToJpegBlobs,
  detectSectionFromHeaderText,
  type MultiSectionGroup,
} from './timetableImport';

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
  // Loaded once so the bulk-import preview can show which section
  // values actually exist for a branch in the real roster — a PDF or
  // spreadsheet's own title ("SEMESTER 3 CSE B") uses whatever letter
  // convention that document happens to use, which is NOT guaranteed
  // to match how sections are actually labeled in student profiles
  // (e.g. a roster using "CSE1"/"CSE2" instead of "A"/"B"). Without
  // this cross-check, a wrong auto-detected section silently saves a
  // timetable that matches zero real students.
  const [rosterSections, setRosterSections] = useState<{ branch: string; section: string }[]>([]);
  useEffect(() => {
    getDocs(collection(db, 'roster')).then((snap) => {
      const seen = new Set<string>();
      const list: { branch: string; section: string }[] = [];
      snap.docs.forEach((d) => {
        const data = d.data() as { branch?: string; section?: string };
        if (!data.branch || !data.section) return;
        const key = `${data.branch}|${data.section}`;
        if (!seen.has(key)) {
          seen.add(key);
          list.push({ branch: data.branch, section: data.section });
        }
      });
      setRosterSections(list);
    });
  }, []);

  // Loaded once so imported timetable slots can be enriched with the
  // real subject name, not just the bare code a PDF/spreadsheet shows
  // (e.g. "CS 304" -> "Database Management Systems"). Keyed by
  // branch + a normalized code (spaces stripped, uppercased) since a
  // timetable's own code formatting ("CS 304") doesn't always match
  // curriculum's stored formatting ("CS304") exactly.
  const [curriculumLookup, setCurriculumLookup] = useState<Map<string, string>>(new Map());
  const [curriculumLoading, setCurriculumLoading] = useState(true);
  useEffect(() => {
    getDocs(collection(db, 'curriculum')).then((snap) => {
      const map = new Map<string, string>();
      snap.docs.forEach((d) => {
        const data = d.data() as { branch?: string; code?: string; name?: string };
        if (!data.branch || !data.code || !data.name) return;
        const key = `${data.branch}|${data.code.replace(/\s+/g, '').toUpperCase()}`;
        map.set(key, data.name);
      });
      setCurriculumLookup(map);
      setCurriculumLoading(false);
    });
  }, []);

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

  // Handles both a photo AND a PDF — a PDF's first page is rendered to a
  // JPEG client-side (see timetableImport.ts) and fed through the exact
  // same Vision OCR call as a photo would be. Same accuracy story as a
  // photo either way: a reasonable first pass, always reviewed before
  // saving, never trusted outright.
  const handleImportFromScan = async (file: File) => {
    if (!days) {
      setStatus('Load a section first (Branch/Semester/Section above), then import a scan into it.');
      return;
    }
    setImporting(true);
    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
    setStatus(isPdf ? 'Rendering the PDF page…' : 'Reading the timetable photo…');
    try {
      let uploadBlob: Blob = file;
      let contentType = file.type || 'image/jpeg';
      if (isPdf) {
        uploadBlob = await renderPdfFirstPageToJpegBlob(file);
        contentType = 'image/jpeg';
        setStatus('Reading the rendered page…');
      }

      const storagePath = `timetableScans/${auth.currentUser?.uid ?? 'unknown'}/${Date.now()}.jpg`;
      const fileRef = ref(storage, storagePath);
      await uploadBytes(fileRef, uploadBlob, { contentType });

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
          'Could not confidently detect the day/time grid in this scan — the full extracted text is available below to transcribe from manually.',
        );
        setShowImportRawText(true);
        return;
      }

      // Best-effort only — this replaces whatever's currently in the
      // editor with the scan's guesses, on the assumption this is being
      // used to start a fresh timetable from a new emailed photo/PDF,
      // not to patch an existing one. Every cell still needs to be
      // checked against the original document before saving; nothing
      // here is trusted as final.
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
        `Imported a rough first pass from the scan — go through every cell below and fix/split the text before saving. This is approximate, not exact.`,
      );
      setShowImportRawText(true);
    } catch (err: any) {
      setStatus(`Import failed: ${err.message}`);
    } finally {
      setImporting(false);
    }
  };

  // Fully automatic — no OCR guessing involved. Parses an .xlsx/.xls/.csv
  // deterministically (see timetableImport.ts) straight into the editor's
  // day/slot structure. Still shown in the editor rather than saved
  // directly, so a typo'd source column or unexpected day name is caught
  // before it reaches students, but there's no per-cell reconstruction
  // needed the way a scan import has.
  const [spreadsheetImporting, setSpreadsheetImporting] = useState(false);

  // Bulk Excel/CSV: parsed groups sit here for review before any
  // Firestore write happens — nothing gets saved until "Confirm & Save
  // All" is clicked, same "show it before committing" principle as the
  // single-section import, just applied to many sections at once instead
  // of many cells within one section.
  const [bulkExcelImporting, setBulkExcelImporting] = useState(false);
  const [bulkExcelPreview, setBulkExcelPreview] = useState<{ groups: MultiSectionGroup[]; skippedRowCount: number } | null>(null);
  const [bulkExcelSaving, setBulkExcelSaving] = useState(false);

  // Bulk PDF: each page is OCR'd into a queue, then reviewed ONE AT A
  // TIME through the exact same branch/semester/section/days editor
  // already used for a single-section import — never auto-saved, since
  // OCR per page is exactly as approximate as the single-photo import
  // already is, just repeated across every page.
  const [bulkPdfImporting, setBulkPdfImporting] = useState(false);
  const [bulkPdfQueue, setBulkPdfQueue] = useState<{ pageNumber: number; branch: string; semester: string; section: string; days: TimetableDay[]; rawText: string; undetected: boolean }[]>([]);
  const [bulkPdfIndex, setBulkPdfIndex] = useState(0);
  const handleImportFromSpreadsheet = async (file: File) => {
    if (!days) {
      setStatus('Load a section first (Branch/Semester/Section above), then import a sheet into it.');
      return;
    }
    setSpreadsheetImporting(true);
    setStatus('Reading the spreadsheet…');
    try {
      const { days: parsedDays, skippedRowCount } = await parseSpreadsheetFile(file);
      setDays(parsedDays);
      const totalSlots = parsedDays.reduce((sum, d) => sum + d.slots.length, 0);
      setStatus(
        skippedRowCount > 0
          ? `Imported ${totalSlots} classes. ${skippedRowCount} row(s) were skipped — their Day or time columns weren't recognizable. Review below, then save.`
          : `Imported ${totalSlots} classes from the sheet. Review below, then save.`,
      );
    } catch (err: any) {
      setStatus(`Import failed: ${err.message}`);
    } finally {
      setSpreadsheetImporting(false);
    }
  };

  // Bulk Excel/CSV — parses the whole sheet into per-section groups and
  // shows them for review; nothing is saved until handleConfirmBulkExcel
  // runs. Independent of the single-section Branch/Semester/Section
  // fields above — a bulk import covers many sections, so it doesn't
  // make sense to gate it on one section being "loaded" first.
  const handleImportAllFromSpreadsheet = async (file: File) => {
    if (curriculumLoading) {
      setStatus('Still loading curriculum — wait a second and try choosing the file again.');
      return;
    }
    setBulkExcelImporting(true);
    setStatus('');
    setBulkExcelPreview(null);
    try {
      const result = await parseAnySpreadsheetAllSections(file);
      if (result.groups.length === 0) {
        setStatus('No recognizable section rows found in this sheet.');
        return;
      }
      // Fill in each slot's real subject name from Curriculum — a
      // timetable source only ever has the bare code ("CS 304"), never
      // the full name, so this is the only place that name comes from.
      // A slot whose code has no curriculum match at all (e.g. a
      // division/elective code not yet in Curriculum) is left with an
      // empty name rather than a guess.
      for (const group of result.groups) {
        for (const day of group.days) {
          for (const slot of day.slots) {
            const key = `${group.branch}|${slot.subjectCode.replace(/\s+/g, '').toUpperCase()}`;
            const name = curriculumLookup.get(key);
            if (name) slot.subjectName = name;
          }
        }
      }
      setBulkExcelPreview(result);
    } catch (err: any) {
      setStatus(`Import failed: ${err.message}`);
    } finally {
      setBulkExcelImporting(false);
    }
  };

  // Lets the reviewer correct a detected group's branch/section before
  // saving anything — needed because auto-detection reads whatever
  // convention the SOURCE FILE happens to use, which isn't guaranteed
  // to match the roster's actual section labels.
  const updateBulkExcelGroupField = (index: number, field: 'branch' | 'section', value: string) => {
    if (!bulkExcelPreview) return;
    const nextGroups = [...bulkExcelPreview.groups];
    nextGroups[index] = { ...nextGroups[index], [field]: value };
    setBulkExcelPreview({ ...bulkExcelPreview, groups: nextGroups });
  };

  const handleConfirmBulkExcelSave = async () => {
    if (!bulkExcelPreview) return;
    const unmatched = bulkExcelPreview.groups.filter((g) => {
      const realSections = rosterSections.filter((r) => r.branch === g.branch).map((r) => r.section);
      return realSections.length > 0 && !realSections.includes(g.section);
    });
    if (unmatched.length > 0) {
      setStatus(
        `Fix ${unmatched.length} row(s) before saving — each Section dropdown must be set to a real roster value (rows: ${unmatched.map((g) => `${g.branch} Sem ${g.semester}`).join(', ')}).`,
      );
      return;
    }
    if (
      !confirm(
        `Save ${bulkExcelPreview.groups.length} section(s)? This replaces the existing schedule for each one listed, entirely.`,
      )
    )
      return;
    setBulkExcelSaving(true);
    let savedCount = 0;
    try {
      for (const group of bulkExcelPreview.groups) {
        const id = timetableDocId(group.branch, group.semester, group.section);
        const sortedDays = group.days.map((d) => ({
          day: d.day,
          slots: [...d.slots]
            .filter((s) => s.startTime && s.subjectCode)
            .sort((a, b) => a.startTime.localeCompare(b.startTime)),
        }));
        await setDoc(doc(db, 'timetable', id), {
          branch: group.branch,
          semester: group.semester,
          section: group.section,
          days: sortedDays,
          updatedAt: serverTimestamp(),
        });
        savedCount++;
      }
      setStatus(`Saved ${savedCount} section(s) from the sheet.`);
      setBulkExcelPreview(null);
    } catch (err: any) {
      setStatus(`Saved ${savedCount} of ${bulkExcelPreview.groups.length} before this failed: ${err.message}`);
    } finally {
      setBulkExcelSaving(false);
    }
  };

  // Bulk PDF — OCRs every page, tries to auto-detect each page's
  // section from its own title text, and queues them up for one-at-a-
  // time review through the normal single-section editor below (see
  // loadBulkPdfQueueItem). Each page still costs one Vision OCR call,
  // same as importing that many photos individually would.
  const handleImportAllFromPdf = async (file: File) => {
    setBulkPdfImporting(true);
    setStatus('Rendering PDF pages…');
    try {
      const blobs = await renderAllPdfPagesToJpegBlobs(file);
      const queue: typeof bulkPdfQueue = [];
      const extractTimetableInfo = httpsCallable<
        {storagePath: string; bucket: string},
        {rawText: string; slots: {day: string; startTime: string; endTime: string; rawText: string}[]}
      >(functions, 'extractTimetableInfo');
      const bucket = import.meta.env.VITE_FIREBASE_STORAGE_BUCKET as string;

      for (let i = 0; i < blobs.length; i++) {
        setStatus(`Reading page ${i + 1} of ${blobs.length}…`);
        const storagePath = `timetableScans/${auth.currentUser?.uid ?? 'unknown'}/${Date.now()}-page${i + 1}.jpg`;
        const fileRef = ref(storage, storagePath);
        await uploadBytes(fileRef, blobs[i], { contentType: 'image/jpeg' });
        const result = await extractTimetableInfo({ storagePath, bucket });
        const { rawText, slots } = result.data;
        const detected = detectSectionFromHeaderText(rawText);
        const pageDays: TimetableDay[] = WEEKDAYS.map((day) => ({
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
        queue.push({
          pageNumber: i + 1,
          branch: detected?.branch ?? '',
          semester: detected ? String(detected.semester) : '',
          section: detected?.section ?? '',
          days: pageDays,
          rawText,
          undetected: !detected,
        });
      }

      setBulkPdfQueue(queue);
      setBulkPdfIndex(0);
      if (queue.length > 0) {
        loadBulkPdfQueueItem(queue[0]);
      }
      const undetectedCount = queue.filter((q) => q.undetected).length;
      setStatus(
        `Read ${queue.length} page(s).${undetectedCount > 0 ? ` ${undetectedCount} page(s) couldn't auto-detect their section — fill in Branch/Semester/Section by hand for those.` : ''} Reviewing page 1 of ${queue.length} below.`,
      );
    } catch (err: any) {
      setStatus(`Import failed: ${err.message}`);
    } finally {
      setBulkPdfImporting(false);
    }
  };

  function loadBulkPdfQueueItem(item: (typeof bulkPdfQueue)[number]) {
    setBranch(item.branch);
    setSemester(item.semester);
    setSection(item.section);
    setDays(item.days);
    setExisted(false);
    setImportRawText(item.rawText);
  }

  // Advances the review queue after either a manual "Skip" or right
  // after handleSave succeeds while a batch is active (wired in below) —
  // same page-by-page review flow either way, just two different ways
  // to move past the current page.
  const advanceBulkPdfQueue = () => {
    const nextIndex = bulkPdfIndex + 1;
    if (nextIndex < bulkPdfQueue.length) {
      setBulkPdfIndex(nextIndex);
      loadBulkPdfQueueItem(bulkPdfQueue[nextIndex]);
      setStatus(`Reviewing page ${nextIndex + 1} of ${bulkPdfQueue.length}.`);
    } else {
      setBulkPdfQueue([]);
      setBulkPdfIndex(0);
      setStatus('Finished reviewing all pages.');
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
    if (!branch.trim() || !semester.trim() || !section.trim()) {
      // Most relevant during bulk PDF review — a page whose section
      // couldn't be auto-detected leaves these blank, and saving with
      // an incomplete id would silently create a malformed timetable
      // doc no student's app would ever query correctly.
      setStatus('Fill in Branch, Semester, and Section before saving — this page could not auto-detect one or more of them.');
      return;
    }
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
      setExisted(true);
      if (bulkPdfQueue.length > 0) {
        // Mid-batch-review save — move straight to the next queued page
        // instead of leaving the reviewer to notice and click into it.
        setStatus(`Saved ${branch.trim().toUpperCase()} Sem ${semester} ${section.trim()}.`);
        advanceBulkPdfQueue();
      } else {
        setStatus(`Saved. Students in ${branch.trim().toUpperCase()} Sem ${semester} ${section.trim()} will see this immediately.`);
      }
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

      <div style={{ marginTop: '1.5rem', padding: '1rem', border: '1px solid var(--border, #ddd)', borderRadius: 8 }}>
        <h2 style={{ fontSize: '1.05rem', marginTop: 0 }}>Upload the whole college at once</h2>
        <p style={{ fontSize: '0.8rem', color: 'var(--ink-soft)' }}>
          For a single Excel/CSV or PDF covering every section, instead of doing this one class at a
          time below.
        </p>

        <label>
          Whole-college Excel/CSV (automatic — needs Branch, Semester, Section, Day, Start Time, End
          Time columns on every row){curriculumLoading ? ' — loading curriculum, one moment...' : ''}
        </label>
        <input
          type="file"
          accept=".xlsx,.xls,.csv"
          disabled={bulkExcelImporting || curriculumLoading}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleImportAllFromSpreadsheet(file);
            e.target.value = '';
          }}
        />

        {bulkExcelPreview && (
          <div style={{ marginTop: '1rem' }}>
            <p style={{ fontSize: '0.85rem' }}>
              Found {bulkExcelPreview.groups.length} section(s)
              {bulkExcelPreview.skippedRowCount > 0
                ? ` (${bulkExcelPreview.skippedRowCount} row(s) skipped — unrecognizable Day/Branch/Semester)`
                : ''}
              — check each Branch/Section below against your real roster before saving. A row
              marked "no roster match" means no student's profile actually has that exact
              branch+section combination, so nobody would ever see that timetable.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {bulkExcelPreview.groups.map((g, i) => {
                const realSectionsForBranch = Array.from(
                  new Set(rosterSections.filter((r) => r.branch === g.branch).map((r) => r.section)),
                );
                const hasMatch = realSectionsForBranch.includes(g.section);
                return (
                  <div
                    key={i}
                    style={{
                      display: 'flex',
                      gap: '0.5rem',
                      alignItems: 'center',
                      padding: '0.5rem',
                      border: '1px solid var(--line)',
                      borderRadius: 4,
                      fontSize: '0.85rem',
                    }}
                  >
                    <input
                      type="text"
                      value={g.branch}
                      onChange={(e) => updateBulkExcelGroupField(i, 'branch', e.target.value.toUpperCase())}
                      style={{ width: 70 }}
                    />
                    <span>Sem {g.semester}</span>
                    <select
                      value={hasMatch ? g.section : ''}
                      onChange={(e) => updateBulkExcelGroupField(i, 'section', e.target.value)}
                      style={{ width: 130 }}
                    >
                      <option value="" disabled>
                        {realSectionsForBranch.length > 0 ? 'Pick the real section...' : `No ${g.branch} students in roster`}
                      </option>
                      {realSectionsForBranch.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                    <span>— {g.days.reduce((sum, d) => sum + d.slots.length, 0)} classes</span>
                    {rosterSections.length > 0 &&
                      (hasMatch ? (
                        <span style={{ color: '#16a34a' }}>✓ matches roster</span>
                      ) : (
                        <span style={{ color: '#b91c1c' }}>
                          ⚠ pick the real section on the left before saving
                        </span>
                      ))}
                  </div>
                );
              })}
            </div>
            <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.75rem' }}>
              <button onClick={handleConfirmBulkExcelSave} disabled={bulkExcelSaving}>
                {bulkExcelSaving ? 'Saving…' : `Confirm & Save All ${bulkExcelPreview.groups.length} Section(s)`}
              </button>
              <button
                className="button-secondary"
                onClick={() => setBulkExcelPreview(null)}
                disabled={bulkExcelSaving}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        <label style={{ display: 'block', marginTop: '1.25rem' }}>
          Whole-college PDF (one page per section — approximate, reviewed page-by-page below before
          saving)
        </label>
        <input
          type="file"
          accept=".pdf,application/pdf"
          disabled={bulkPdfImporting}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleImportAllFromPdf(file);
            e.target.value = '';
          }}
        />
        {bulkPdfQueue.length > 0 && (
          <p style={{ fontSize: '0.85rem', marginTop: '0.5rem' }}>
            Reviewing page {bulkPdfIndex + 1} of {bulkPdfQueue.length} in the editor below — check
            Branch/Semester/Section and the detected classes, then click Save to move to the next
            page.{' '}
            <button className="button-secondary" onClick={advanceBulkPdfQueue} style={{ marginLeft: '0.5rem' }}>
              Skip this page
            </button>
          </p>
        )}
      </div>

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
          <label>Import from an Excel/CSV sheet (automatic — Day, Start Time, End Time columns required)</label>
          <input
            type="file"
            accept=".xlsx,.xls,.csv"
            disabled={spreadsheetImporting}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleImportFromSpreadsheet(file);
              e.target.value = '';
            }}
          />

          <label style={{ display: 'block', marginTop: '1rem' }}>
            Import from a timetable photo or PDF (optional — approximate, always review before saving)
          </label>
          <input
            type="file"
            accept="image/*,.pdf,application/pdf"
            disabled={importing}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleImportFromScan(file);
              e.target.value = '';
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
