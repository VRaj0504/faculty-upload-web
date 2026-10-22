import { useEffect, useState } from 'react';
import {
  collection,
  query,
  where,
  orderBy,
  onSnapshot,
  doc,
  updateDoc,
  writeBatch,
  serverTimestamp,
  Timestamp,
} from 'firebase/firestore';
import { ref, getDownloadURL } from 'firebase/storage';
import { auth, db, storage } from './firebaseConfig';
import ExamSheetReview from './ExamSheetReview';
import SubjectSelect from './SubjectSelect';
import type { ExamGroup } from './examSheetParser';
import { currentAcademicYear, examYearOptions } from './academicYear';

const BRANCHES = ['CSE', 'ECE', 'MNC'] as const;

type TargetScope = {
  scope: 'all' | 'branch' | 'section';
  branch: 'CSE' | 'ECE' | 'MNC' | null;
  semester: number | null;
  section: string | null;
  admissionYear: number | null;
  specialization: string | null;
};

type PendingImport = {
  id: string;
  fromEmail: string;
  fromName: string;
  subject: string;
  bodySnippet: string;
  attachments: { filename: string; storagePath: string; mimeType: string; downloadUrl?: string }[];
  contentType: 'resource' | 'timetable' | 'notice' | 'unclear' | 'examSchedule';
  confidence: 'high' | 'medium' | 'low';
  title: string;
  targetScope: TargetScope;
  resourceType: 'Notes' | 'PYQ' | 'Slides' | 'Assignment' | null;

  resourceExamYear?: number | null;
  resourceSubject: string | null;
  noticeCategory: 'Academic' | 'Placement' | 'Event' | 'General' | null;
  noticeDescription: string | null;
  reasoning: string;

  examGroups?: ExamGroup[];
  examWarnings?: string[];
  status: 'pending' | 'approved' | 'rejected';
  receivedAt: Timestamp | null;
};

function isDirectlyPublishable(contentType: PendingImport['contentType']) {
  return contentType === 'resource' || contentType === 'notice';
}

function ExamImportCard({
  item,
  busy,
  onReject,
  onPublished,
}: {
  item: PendingImport;
  busy: boolean;
  onReject: () => void;
  onPublished: () => void;
}) {
  const [open, setOpen] = useState(false);
  const pdf = item.attachments[0];
  const groups = item.examGroups ?? [];

  return (
    <div className="card" style={{ marginTop: '1.2rem', padding: '1.4rem 1.6rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontWeight: 600 }}>{item.subject}</div>
          <div className="eyebrow" style={{ fontSize: '0.7rem', marginTop: '0.2rem' }}>
            {item.fromName} · {item.fromEmail}
          </div>
        </div>
        <span className="eyebrow" style={{ fontSize: '0.65rem', padding: '0.2rem 0.5rem', borderRadius: 6, backgroundColor: '#e0f2fe' }}>
          exam date sheet
        </span>
      </div>

      <p style={{ fontSize: '0.85rem', marginTop: '0.6rem', color: 'var(--ink-soft)' }}>{item.reasoning}</p>

      <div style={{ display: 'flex', gap: '0.8rem', marginTop: '1rem' }}>
        <button onClick={() => setOpen((v) => !v)} disabled={busy} style={{ flex: 1 }}>
          {open ? 'Hide review' : `Review & publish (${groups.length} sheets)`}
        </button>
        <button onClick={onReject} disabled={busy} className="button-secondary" style={{ flex: 1 }}>
          Reject
        </button>
      </div>

      {open && (
        <ExamSheetReview
          initialGroups={groups}
          warnings={item.examWarnings ?? []}
          sourcePdf={pdf?.downloadUrl ? { url: pdf.downloadUrl, name: pdf.filename } : null}
          onPublished={onPublished}
        />
      )}
    </div>
  );
}

function InboxImports() {
  const [imports, setImports] = useState<PendingImport[]>([]);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Partial<PendingImport>>>({});
  const [attachmentUrls, setAttachmentUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    const q = query(
      collection(db, 'pendingImports'),
      where('status', '==', 'pending'),
      orderBy('receivedAt', 'desc'),
    );
    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        setError('');
        setImports(snapshot.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<PendingImport, 'id'>) })));
      },
      (err) => {
        console.error('Inbox Imports query failed:', err);
        setError(
          'Could not load imports. Open the browser console (F12) — Firebase usually prints a link there to create a missing index; click it, wait a minute, then reload.',
        );
      },
    );
    return () => unsubscribe();
  }, []);

  const draftFor = (item: PendingImport) => ({ ...item, ...drafts[item.id] });

  const updateDraft = (id: string, patch: Partial<PendingImport>) => {
    setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  };

  const resolveAttachmentUrl = async (storagePath: string) => {
    if (attachmentUrls[storagePath]) return;
    try {
      const url = await getDownloadURL(ref(storage, storagePath));
      setAttachmentUrls((prev) => ({ ...prev, [storagePath]: url }));
    } catch (err: any) {
      console.error(`Could not resolve ${storagePath}:`, err.message);
    }
  };

  const handleReject = async (item: PendingImport) => {
    const reason = prompt(`Reject "${item.title}"? Optional reason:`) ?? '';
    setBusyId(item.id);
    try {
      await updateDoc(doc(db, 'pendingImports', item.id), {
        status: 'rejected',
        reviewedBy: auth.currentUser?.uid,
        reviewedAt: serverTimestamp(),
        rejectionReason: reason,
      });
    } catch (err: any) {
      alert(`Could not reject: ${err.message}`);
    } finally {
      setBusyId(null);
    }
  };

  const markApproved = async (item: PendingImport) => {
    try {
      await updateDoc(doc(db, 'pendingImports', item.id), {
        status: 'approved',
        reviewedBy: auth.currentUser?.uid,
        reviewedAt: serverTimestamp(),
      });
    } catch (err: any) {
      alert(`Published, but couldn't mark the email as handled: ${err.message}`);
    }
  };

  const handleApprove = async (item: PendingImport) => {
    const current = draftFor(item);
    setBusyId(item.id);
    try {
      const scope = current.targetScope;

      if (current.contentType === 'resource' || current.contentType === 'notice') {
        if (scope.scope !== 'all' && !scope.branch) {
          throw new Error('Pick the branch this is for before approving.');
        }
      }

      const batch = writeBatch(db);

      if (current.contentType === 'resource') {
        const attachment = current.attachments[0];
        if (!attachment) throw new Error('No attachment to file as a resource.');
        if (!scope.semester) throw new Error('Pick the semester this resource is for before approving.');
        const fileUrl = await getDownloadURL(ref(storage, attachment.storagePath));
        if ((current.resourceType ?? 'Notes') === 'PYQ' && !current.resourceExamYear) {
          throw new Error('Pick the exam year for this paper before approving it.');
        }
        const targetBranches = scope.scope === 'all' ? BRANCHES : [scope.branch as string];
        for (const b of targetBranches) {
          batch.set(doc(collection(db, 'resources')), {
            title: current.title,
            subject: current.resourceSubject || current.title,
            branch: b,
            semester: scope.semester,
            type: current.resourceType ?? 'Notes',
            academicYear: currentAcademicYear(),
            examYear: (current.resourceType ?? 'Notes') === 'PYQ' ? current.resourceExamYear ?? null : null,
            fileUrl,
            storagePath: attachment.storagePath,
            uploadedBy: auth.currentUser?.uid,
            uploadedByName: current.fromName,
            createdAt: serverTimestamp(),
          });
        }
      } else if (current.contentType === 'notice') {
        batch.set(doc(collection(db, 'notices')), {
          title: current.title,
          description: current.noticeDescription || current.bodySnippet,
          category: current.noticeCategory ?? 'General',
          clubId: null,
          clubName: null,
          createdBy: auth.currentUser?.uid,
          createdByName: current.fromName,
          createdAt: serverTimestamp(),
          targetBranch: scope.scope === 'all' ? null : scope.branch,
          targetSection: scope.section ?? null,
          targetAdmissionYear: scope.admissionYear ?? null,
          targetSpecialization: scope.specialization ?? null,
        });
      } else {
        throw new Error('Timetable/unclear items are reviewed in their own tab, not published from here.');
      }

      batch.update(doc(db, 'pendingImports', item.id), {
        status: 'approved',
        reviewedBy: auth.currentUser?.uid,
        reviewedAt: serverTimestamp(),
      });
      await batch.commit();
    } catch (err: any) {
      alert(`Could not publish: ${err.message}`);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '2rem 0' }}>
      <div className="card" style={{ width: 640, padding: '2rem 2.5rem' }}>
        <h1 style={{ fontSize: '1.5rem' }}>Inbox Imports</h1>
        <p style={{ color: 'var(--ink-soft)', fontSize: '0.9rem' }}>
          Emails faculty send to the resources inbox, auto-classified — review and publish, or reject.
        </p>

        {error && <p className="error-text" style={{ marginTop: '1rem' }}>{error}</p>}
        {!error && imports.length === 0 && (
          <p style={{ color: 'var(--ink-soft)', marginTop: '1rem' }}>Nothing waiting for review.</p>
        )}

        {imports.map((item) => {
          const current = draftFor(item);
          const busy = busyId === item.id;
          if (item.contentType === 'examSchedule') {
            return (
              <ExamImportCard
                key={item.id}
                item={item}
                busy={busy}
                onReject={() => handleReject(item)}
                onPublished={() => markApproved(item)}
              />
            );
          }
          return (
            <div key={item.id} className="card" style={{ marginTop: '1.2rem', padding: '1.4rem 1.6rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <div style={{ fontWeight: 600 }}>{item.subject}</div>
                  <div className="eyebrow" style={{ fontSize: '0.7rem', marginTop: '0.2rem' }}>
                    {item.fromName} · {item.fromEmail}
                  </div>
                </div>
                <span
                  className="eyebrow"
                  style={{
                    fontSize: '0.65rem',
                    padding: '0.2rem 0.5rem',
                    borderRadius: 6,
                    backgroundColor:
                      item.confidence === 'high' ? '#dcfce7' : item.confidence === 'medium' ? '#fef9c3' : '#fee2e2',
                  }}
                >
                  {item.confidence} confidence
                </span>
              </div>

              <p style={{ fontSize: '0.85rem', marginTop: '0.6rem', color: 'var(--ink-soft)' }}>{item.reasoning}</p>
              {item.bodySnippet && (
                <p style={{ fontSize: '0.85rem', marginTop: '0.4rem', whiteSpace: 'pre-wrap' }}>
                  {item.bodySnippet}
                </p>
              )}

              {item.attachments.map((att) => (
                <div key={att.storagePath} style={{ marginTop: '0.5rem' }}>
                  {attachmentUrls[att.storagePath] ? (
                    <a href={attachmentUrls[att.storagePath]} target="_blank" rel="noreferrer">
                      {att.filename}
                    </a>
                  ) : (
                    <button className="button-secondary" onClick={() => resolveAttachmentUrl(att.storagePath)}>
                      Load {att.filename}
                    </button>
                  )}
                </div>
              ))}

              <div style={{ display: 'flex', gap: '0.8rem', marginTop: '1rem' }}>
                <div style={{ flex: 1 }}>
                  <label>Content type</label>
                  <select
                    value={current.contentType}
                    onChange={(e) => updateDraft(item.id, { contentType: e.target.value as PendingImport['contentType'] })}
                  >
                    <option value="resource">Resource</option>
                    <option value="notice">Notice</option>
                    <option value="timetable">Timetable (review in Timetable Editor)</option>
                    <option value="unclear">Unclear</option>
                  </select>
                </div>
                <div style={{ flex: 1 }}>
                  <label>Title</label>
                  <input value={current.title} onChange={(e) => updateDraft(item.id, { title: e.target.value })} />
                </div>
              </div>

              <div style={{ display: 'flex', gap: '0.8rem', marginTop: '0.8rem' }}>
                <div style={{ flex: 1 }}>
                  <label>Scope</label>
                  <select
                    value={current.targetScope.scope}
                    onChange={(e) =>
                      updateDraft(item.id, { targetScope: { ...current.targetScope, scope: e.target.value as TargetScope['scope'] } })
                    }
                  >
                    <option value="all">Whole college</option>
                    <option value="branch">One branch</option>
                    <option value="section">One section</option>
                  </select>
                </div>
                {current.targetScope.scope !== 'all' && (
                  <div style={{ flex: 1 }}>
                    <label>Branch</label>
                    <select
                      value={current.targetScope.branch ?? 'CSE'}
                      onChange={(e) =>
                        updateDraft(item.id, { targetScope: { ...current.targetScope, branch: e.target.value as TargetScope['branch'] } })
                      }
                    >
                      {BRANCHES.map((b) => (
                        <option key={b} value={b}>{b}</option>
                      ))}
                    </select>
                  </div>
                )}
                {current.targetScope.scope !== 'all' && (
                  <div style={{ flex: 1 }}>
                    <label>Semester</label>
                    <select
                      value={current.targetScope.semester ?? ''}
                      onChange={(e) =>
                        updateDraft(item.id, {
                          targetScope: { ...current.targetScope, semester: e.target.value ? Number(e.target.value) : null },
                        })
                      }
                    >
                      <option value="">Select...</option>
                      {[1, 2, 3, 4, 5, 6, 7, 8].map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                )}
                {current.targetScope.scope === 'section' && (
                  <div style={{ flex: 1 }}>
                    <label>Section</label>
                    <select
                      value={current.targetScope.section ?? ''}
                      onChange={(e) =>
                        updateDraft(item.id, { targetScope: { ...current.targetScope, section: e.target.value } })
                      }
                    >
                      <option value="">Select...</option>
                      {Array.from(new Set(['A', 'B', 'C', 'D', ...(current.targetScope.section ? [current.targetScope.section] : [])])).map((sec) => (
                        <option key={sec} value={sec}>{sec}</option>
                      ))}
                    </select>
                  </div>
                )}
              </div>

              {current.contentType === 'resource' && (
                <div style={{ display: 'flex', gap: '0.8rem', marginTop: '0.8rem' }}>
                  <div style={{ flex: 1 }}>
                    <label>Subject</label>
                    <SubjectSelect
                      branch={current.targetScope.branch ?? ''}
                      semester={current.targetScope.semester}
                      code=""
                      name={current.resourceSubject ?? ''}
                      onChange={(n) => updateDraft(item.id, { resourceSubject: n.name })}
                    />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label>Type</label>
                    <select
                      value={current.resourceType ?? 'Notes'}
                      onChange={(e) => updateDraft(item.id, { resourceType: e.target.value as PendingImport['resourceType'] })}
                    >
                      <option value="Notes">Notes</option>
                      <option value="Slides">Slides</option>
                      <option value="Assignment">Assignment</option>
                      <option value="PYQ">PYQ</option>
                    </select>
                  </div>
                  {(current.resourceType ?? 'Notes') === 'PYQ' && (
                    <div style={{ flex: 1 }}>
                      <label>Exam year</label>
                      <select
                        value={current.resourceExamYear ?? ''}
                        onChange={(e) =>
                          updateDraft(item.id, { resourceExamYear: e.target.value === '' ? null : Number(e.target.value) })
                        }
                      >
                        <option value="">Pick year…</option>
                        {examYearOptions().map((y) => (
                          <option key={y} value={y}>{y}</option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
              )}

              {current.contentType === 'notice' && (
                <div style={{ marginTop: '0.8rem' }}>
                  <label>Notice text</label>
                  <textarea
                    value={current.noticeDescription ?? ''}
                    onChange={(e) => updateDraft(item.id, { noticeDescription: e.target.value })}
                    rows={3}
                  />
                </div>
              )}

              <div style={{ display: 'flex', gap: '0.8rem', marginTop: '1.2rem' }}>
                <button
                  onClick={() => handleApprove(item)}
                  disabled={busy || !isDirectlyPublishable(current.contentType)}
                  style={{ flex: 1 }}
                  title={
                    isDirectlyPublishable(current.contentType)
                      ? undefined
                      : 'Timetable imports are approved from the Timetable Editor tab, using its attachment.'
                  }
                >
                  {busy ? 'Publishing…' : 'Approve & Publish'}
                </button>
                <button onClick={() => handleReject(item)} disabled={busy} className="button-secondary" style={{ flex: 1 }}>
                  Reject
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default InboxImports;
