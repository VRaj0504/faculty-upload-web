import { useState } from 'react';
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { db, auth } from './firebaseConfig';
import { EXAM_TYPES, examDocId, sortEntries, validateEntries } from './examSheetParser';
import type { ExamGroup, ExamTypeId } from './examSheetParser';
import { uploadExamSheetPdf } from './examPdf';
import ExamEditor from './ExamEditor';

function ExamSheetReview({
  initialGroups,
  warnings = [],
  sourceFile = null,
  sourcePdf = null,
  onPublished,
}: {
  initialGroups: ExamGroup[];
  warnings?: string[];
  sourceFile?: File | null;
  sourcePdf?: { url: string; name: string } | null;
  onPublished: (count: number) => void;
}) {
  const [groups, setGroups] = useState<ExamGroup[]>(initialGroups);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');

  const patchGroup = (gi: number, patch: Partial<ExamGroup>) =>
    setGroups((prev) => prev.map((g, i) => (i === gi ? { ...g, ...patch } : g)));

  const setType = (gi: number, id: ExamTypeId) =>
    patchGroup(gi, { examType: id, examTypeLabel: EXAM_TYPES.find((t) => t.id === id)?.label ?? id });

  const handlePublish = async () => {
    if (groups.length === 0) {
      setStatus('Nothing to publish.');
      return;
    }
    for (const g of groups) {
      const err = validateEntries(g.entries);
      if (err) {
        setStatus(`${g.branch} Sem ${g.semester} (${g.examTypeLabel}) — ${err}`);
        return;
      }
    }
    const ids = groups.map((g) => examDocId(g.branch, g.semester, g.examType));
    if (new Set(ids).size !== ids.length) {
      setStatus('Two sheets have the same branch, semester and exam type — change one of them or remove it.');
      return;
    }

    setSaving(true);
    try {
      const existing = (await Promise.all(ids.map((id) => getDoc(doc(db, 'examSchedules', id))))).filter((s) => s.exists()).length;
      const totalExams = groups.reduce((n, g) => n + g.entries.length, 0);
      const ok = confirm(
        `Publish ${groups.length} date sheet${groups.length === 1 ? '' : 's'} (${totalExams} exams)? Students in each semester get a notification.` +
          (existing ? ` ${existing} of these replace sheets that are already published.` : ''),
      );
      if (!ok) {
        setSaving(false);
        return;
      }

      setStatus('Publishing...');
      const pdf = sourceFile ? await uploadExamSheetPdf(sourceFile) : sourcePdf;

      let done = 0;
      for (let i = 0; i < groups.length; i++) {
        const g = groups[i];
        await setDoc(doc(db, 'examSchedules', ids[i]), {
          branch: g.branch,
          semester: g.semester,
          examType: g.examType,
          examTypeLabel: g.examTypeLabel,
          entries: sortEntries(g.entries).map((e) => ({
            date: e.date,
            startTime: e.startTime,
            endTime: e.endTime,
            subjectCode: e.subjectCode.trim().toUpperCase(),
            subjectName: e.subjectName.trim(),
            venue: e.venue.trim(),
          })),
          ...(pdf ? { sourcePdfUrl: pdf.url, sourcePdfName: pdf.name } : {}),
          updatedAt: serverTimestamp(),
          updatedBy: auth.currentUser?.uid ?? 'web-portal',
          updatedByEmail: auth.currentUser?.email ?? '',
        });
        done++;
      }
      onPublished(done);
    } catch (e: any) {
      setStatus(`Publish failed: ${e.message}. Press Publish again — already-written sheets are simply overwritten with the same data.`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ marginTop: '1.25rem' }}>
      {warnings.length > 0 && (
        <div style={{ background: '#fef3c7', borderRadius: 6, padding: '0.75rem 1rem', fontSize: '0.82rem' }}>
          <strong>Check these against the sheet:</strong>
          <ul style={{ margin: '0.4rem 0 0', paddingLeft: '1.2rem' }}>
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {sourcePdf && (
        <p style={{ fontSize: '0.85rem', marginTop: '0.75rem' }}>
          Compare against the original:{' '}
          <a href={sourcePdf.url} target="_blank" rel="noreferrer">
            {sourcePdf.name}
          </a>
        </p>
      )}

      {groups.map((g, gi) => (
        <div key={gi} style={{ marginTop: '1.25rem', padding: '1rem 1.2rem', border: '1px solid var(--rule, #ddd)', borderRadius: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
            <strong style={{ fontSize: '1rem' }}>
              {g.branch} · Semester {g.semester}
            </strong>
            <select value={g.examType} onChange={(e) => setType(gi, e.target.value as ExamTypeId)} style={{ width: 'auto' }}>
              {EXAM_TYPES.map((t) => (
                <option key={t.id} value={t.id}>{t.label}</option>
              ))}
            </select>
            <span style={{ fontSize: '0.8rem', color: 'var(--ink-soft)' }}>{g.entries.length} exams</span>
            <button
              type="button"
              onClick={() => setGroups((prev) => prev.filter((_, i) => i !== gi))}
              style={{ marginLeft: 'auto' }}
            >
              Remove sheet
            </button>
          </div>
          <ExamEditor
            branch={g.branch}
            semester={String(g.semester)}
            examType={g.examType}
            entries={g.entries}
            onChange={(entries) => patchGroup(gi, { entries })}
          />
        </div>
      ))}

      {status && <p style={{ marginTop: '1rem', fontSize: '0.9rem' }}>{status}</p>}

      <button onClick={handlePublish} disabled={saving || groups.length === 0} style={{ width: '100%', marginTop: '1.25rem' }}>
        {saving ? 'Working...' : `Publish ${groups.length} Date Sheet${groups.length === 1 ? '' : 's'}`}
      </button>
    </div>
  );
}

export default ExamSheetReview;
