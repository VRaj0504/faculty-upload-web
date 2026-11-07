import { useState, useEffect } from 'react';
import { collection, addDoc, serverTimestamp, query, where, orderBy, onSnapshot, deleteDoc, doc, getDocs } from 'firebase/firestore';
import { ref, uploadBytesResumable, getDownloadURL, deleteObject } from 'firebase/storage';
import { auth, db, storage } from './firebaseConfig';
import { curriculum } from './curriculum';
import { academicYearStartFor, batchChoices, currentAcademicYear, examYearOptions } from './academicYear';
import { labStatusFor, type LabStatus } from './labDetection';
import { getDocsCached } from './cachedCollection';

const BLOCKED_EXT = /\.(exe|msi|bat|cmd|com|scr|ps1|vbs|sh|apk|aab|ipa|dmg|pkg|app|jar)$/i;

const BRANCHES = ['CSE', 'ECE', 'MNC'] as const;

const SEMESTERS = [1, 2, 3, 4, 5, 6, 7, 8] as const;
const UNITS = [1, 2, 3, 4, 5, 6] as const;

const TYPES = ['Notes', 'Slides', 'Assignment', 'PYQ'] as const;
const BATCH_CHOICES = batchChoices();
const EXAM_YEARS = examYearOptions();

const MAX_FILE_MB = 50;

type BranchCode = typeof BRANCHES[number];

type CommonSubject = {
  key: string;
  name: string;
  perBranch: Record<BranchCode, { code: string; name: string }>;
};

type RosterLite = { branch: string; section: string; admissionYear: number };

const admissionYearForSemester = (sem: number) => academicYearStartFor(new Date()) - Math.floor((sem - 1) / 2);

const normName = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

const pathSafe = (s: string) => s.replace(/[/\\#?[\]*]+/g, '-');

type MyResource = {
  id: string;
  title: string;
  subject: string;
  branch: string;
  semester: number;
  type: string;
  storagePath: string;
  unit?: number | null;
  isLink?: boolean;
};

function Upload() {
  const [files, setFiles] = useState<File[]>([]);
  const [source, setSource] = useState<'file' | 'link'>('file');
  const [offline, setOffline] = useState(false);
  const [link, setLink] = useState('');
  const [title, setTitle] = useState('');
  const [branch, setBranch] = useState<typeof BRANCHES[number]>('CSE');
  const [allBranches, setAllBranches] = useState(false);

  const [commonBranches, setCommonBranches] = useState<BranchCode[]>([...BRANCHES]);
  const [semester, setSemester] = useState<typeof SEMESTERS[number]>(1);

  const [section, setSection] = useState('');
  const [subject, setSubject] = useState('');
  const [customSubject, setCustomSubject] = useState('');

  const [commonSubjectChoice, setCommonSubjectChoice] = useState('');
  const [type, setType] = useState<typeof TYPES[number]>('Notes');

  const [academicYear, setAcademicYear] = useState<string>(currentAcademicYear());

  const [examYear, setExamYear] = useState<number | ''>('');
  const [unit, setUnit] = useState<number | ''>('');

  const [semesterTimetables, setSemesterTimetables] = useState<any[] | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadFileIndex, setUploadFileIndex] = useState(0);
  const [message, setMessage] = useState('');
  const [myResources, setMyResources] = useState<MyResource[]>([]);
  const [myResourcesError, setMyResourcesError] = useState('');

  const [roster, setRoster] = useState<RosterLite[] | null>(null);
  useEffect(() => {
    getDocsCached('roster')
      .then((snap) =>
        setRoster(
          snap.docs.flatMap((d) => {
            const r = d.data() as { branch?: string; section?: string; admissionYear?: number; program?: string };
            if (r.program === 'PG' || /^PG/i.test(d.id)) return [];
            const sec = String(r.section ?? '').trim();
            return r.branch && sec && typeof r.admissionYear === 'number' ? [{ branch: r.branch, section: sec, admissionYear: r.admissionYear }] : [];
          }),
        ),
      )
      .catch(() => setRoster([]));
  }, []);
  const classYear = admissionYearForSemester(semester);
  const sectionOptions = Array.from(
    new Set((roster ?? []).filter((r) => r.branch === branch && r.admissionYear === classYear).map((r) => r.section)),
  ).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  useEffect(() => {
    if (section && (allBranches || (roster && !sectionOptions.includes(section)))) setSection('');
  }, [branch, semester, allBranches, roster]);

  const subjectOptions = curriculum[branch]?.[semester] ?? [];

  const baseBranch: BranchCode | undefined = commonBranches[0];
  const commonSubjectOptions: CommonSubject[] = baseBranch
    ? (curriculum[baseBranch][semester] ?? []).flatMap((baseSubject) => {
        const perBranch = {} as CommonSubject['perBranch'];
        for (const b of commonBranches) {
          const list = curriculum[b][semester] ?? [];
          const match =
            list.find((s) => s.code === baseSubject.code) ??
            list.find((s) => normName(s.name) === normName(baseSubject.name));
          if (!match) return [];
          perBranch[b] = match;
        }
        return [{ key: baseSubject.code, name: baseSubject.name, perBranch }];
      })
    : [];
  const selectedCommon = commonSubjectOptions.find((o) => o.key === commonSubjectChoice) ?? null;
  const OTHER_OPTION = '__other__';

  useEffect(() => {
    if (allBranches) return;
    if (subjectOptions.length > 0 && !subjectOptions.some((s) => s.name === subject)) {
      setSubject(subjectOptions[0].name);
    } else if (subjectOptions.length === 0) {
      setSubject('');
    }
  }, [branch, semester, allBranches]);

  useEffect(() => {
    if (!allBranches) return;

    setCommonSubjectChoice(commonSubjectOptions.length > 0 ? commonSubjectOptions[0].key : OTHER_OPTION);
  }, [semester, allBranches, commonBranches.join(',')]);

  useEffect(() => {
    if (!auth.currentUser) return;

    const q = query(
      collection(db, 'resources'),
      where('uploadedBy', '==', auth.currentUser.uid),
      orderBy('createdAt', 'desc')
    );

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        setMyResourcesError('');
        const items: MyResource[] = snapshot.docs.map((docSnap) => ({
          id: docSnap.id,
          ...(docSnap.data() as Omit<MyResource, 'id'>),
        }));
        setMyResources(items);
      },
      (err) => {

        console.error('My Uploads query failed:', err);
        setMyResourcesError(
          'Could not load your uploads. Open the browser console (F12) — Firebase usually prints a link there to create a missing index; click it, wait a minute, then reload.'
        );
      }
    );

    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (allBranches) {
      setSemesterTimetables(null);
      return;
    }
    let cancelled = false;
    getDocs(query(collection(db, 'timetable'), where('branch', '==', branch), where('semester', '==', semester)))
      .then((snap) => {
        if (!cancelled) setSemesterTimetables(snap.docs.map((d) => d.data()));
      })
      .catch(() => {

        if (!cancelled) setSemesterTimetables(null);
      });
    return () => {
      cancelled = true;
    };
  }, [branch, semester, allBranches]);

  const selectedSubjectCode = subjectOptions.find((s) => s.name === subject)?.code ?? null;
  const labStatus: LabStatus =
    allBranches || !selectedSubjectCode || semesterTimetables === null
      ? 'unknown'
      : labStatusFor(selectedSubjectCode, semesterTimetables);

  const assignmentBlocked = labStatus === 'no-lab';

  useEffect(() => {
    if (type === 'Assignment' && assignmentBlocked) setType('Notes');
  }, [type, assignmentBlocked]);

  const handleUpload = async () => {
    const usingCustom = allBranches && commonSubjectChoice === OTHER_OPTION;
    const effectiveSubject = allBranches
      ? (usingCustom ? customSubject.trim() : selectedCommon?.name ?? '')
      : subject;

    const subjectFor = (b: BranchCode): { subject: string; subjectCode: string | null } => {
      if (!allBranches) return { subject, subjectCode: selectedSubjectCode };
      if (usingCustom || !selectedCommon) return { subject: effectiveSubject, subjectCode: null };
      return { subject: selectedCommon.perBranch[b].name, subjectCode: selectedCommon.perBranch[b].code };
    };
    if (allBranches && commonBranches.length === 0) {
      setMessage('Pick at least one branch for the common subject.');
      return;
    }
    if (source === 'link') {
      if (!effectiveSubject || !title.trim()) {
        setMessage('Please fill in all fields: subject, title and the link.');
        return;
      }
      let url: URL | null = null;
      try {
        url = new URL(link.trim());
      } catch {
        url = null;
      }
      if (!url || !/^https?:$/.test(url.protocol)) {
        setMessage('Could not use that link. Paste the full address starting with https://');
        return;
      }
      if (type === 'PYQ' && examYear === '') {
        setMessage('Pick the exam year — papers are filed by the year the exam was held.');
        return;
      }
      setUploading(true);
      setMessage('');
      try {
        const targetBranches: readonly BranchCode[] = allBranches ? commonBranches : [branch];
        await Promise.all(
          targetBranches.map((b) =>
            addDoc(collection(db, 'resources'), {
              title: title.trim(),
              ...subjectFor(b),
              branch: b,
              semester,
              section: allBranches ? null : section.trim() || null,
              type,
              academicYear,
              examYear: type === 'PYQ' ? Number(examYear) : null,
              unit: type === 'PYQ' || unit === '' ? null : unit,
              fileUrl: url!.href,
              isLink: true,
              linkHost: url!.hostname.replace(/^www\./, ''),
              uploadedBy: auth.currentUser?.uid,
              storagePath: null,
              uploadedByName: auth.currentUser?.email,
              createdAt: serverTimestamp(),
            }),
          ),
        );
        setMessage('Link shared' + (allBranches ? ` for ${commonBranches.join(', ')}.` : '.'));
        setLink('');
        setTitle('');
        setCustomSubject('');
      } catch (err: any) {
        setMessage(`Could not share this link: ${err.message}`);
      } finally {
        setUploading(false);
      }
      return;
    }
    if (files.length === 0 || !effectiveSubject) {
      setMessage('Please fill in all fields and choose at least one file.');
      return;
    }
    if (type === 'PYQ' && examYear === '') {
      setMessage('Pick the exam year — papers are filed by the year the exam was held.');
      return;
    }
    if (type === 'Assignment' && assignmentBlocked) {
      setMessage('This subject has no lab in the timetable, so it has no assignments.');
      return;
    }

    if (files.length === 1 && !title) {
      setMessage('Please fill in all fields and choose a file.');
      return;
    }

    const oversized = files.filter((f) => f.size > MAX_FILE_MB * 1024 * 1024);
    if (oversized.length > 0) {
      setMessage(
        `${oversized.map((f) => `"${f.name}" (${(f.size / (1024 * 1024)).toFixed(1)}MB)`).join(', ')} — the limit here is ${MAX_FILE_MB}MB each. Try compressing, or splitting into parts.`,
      );
      return;
    }

    setUploading(true);
    setUploadProgress(0);
    setUploadFileIndex(0);
    setMessage('');
    const queue = [...files];
    const total = queue.length;
    let doneCount = 0;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    let current: ReturnType<typeof uploadBytesResumable> | null = null;
    const goOffline = () => {
      setOffline(true);
      current?.pause();
    };
    const goOnline = () => {
      setOffline(false);
      current?.resume();
    };
    window.addEventListener('offline', goOffline);
    window.addEventListener('online', goOnline);
    try {
      const targetBranches: readonly BranchCode[] = allBranches ? commonBranches : [branch];
      const stripExtension = (filename: string) => filename.replace(/\.[^.]+$/, '');

      for (let i = 0; i < queue.length; i++) {
        const currentFile = queue[i];
        setUploadFileIndex(i + 1);
        setUploadProgress(0);

        const fileTitle = total > 1 ? stripExtension(currentFile.name) : title;
        const storagePath = `resources/${allBranches ? 'ALL' : branch}/${semester}/${pathSafe(effectiveSubject)}/${Date.now()}-${pathSafe(currentFile.name)}`;
        const fileRef = ref(storage, storagePath);

        const fileUrl = await new Promise<string>((resolve, reject) => {
          const uploadTask = uploadBytesResumable(fileRef, currentFile, {
            contentType: currentFile.type || 'application/octet-stream',
            cacheControl: 'public,max-age=31536000,immutable',
          });
          current = uploadTask;
          if (!navigator.onLine) goOffline();
          uploadTask.on(
            'state_changed',
            (snapshot) => {
              setUploadProgress(Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100));
            },
            (err) => reject(err),
            async () => {
              try {
                resolve(await getDownloadURL(uploadTask.snapshot.ref));
              } catch (err) {
                reject(err);
              }
            },
          );
        });
        current = null;

        await Promise.all(
          targetBranches.map((b) =>
            addDoc(collection(db, 'resources'), {
              title: fileTitle,
              ...subjectFor(b),
              branch: b,
              semester,
              section: allBranches ? null : section.trim() || null,
              type,
              academicYear,
              examYear: type === 'PYQ' ? Number(examYear) : null,
              unit: type === 'PYQ' || unit === '' ? null : unit,
              fileUrl,
              uploadedBy: auth.currentUser?.uid,
              storagePath,
              uploadedByName: auth.currentUser?.email,
              createdAt: serverTimestamp(),
            }),
          ),
        );
        doneCount++;
        setFiles(queue.slice(i + 1));
      }

      setMessage(
        (total > 1 ? `${total} files filed successfully` : 'Filed successfully') +
          (allBranches ? ` for ${commonBranches.join(', ')}.` : '.'),
      );
      setFiles([]);
      setTitle('');
      setCustomSubject('');
    } catch (err: any) {
      const left = total - doneCount;
      setMessage(
        `Could not finish: the upload stopped (${err?.code === 'storage/retry-limit-exceeded' || !navigator.onLine ? 'the internet connection dropped' : err.message}). ` +
          (doneCount ? `${doneCount} of ${total} file${total === 1 ? ' was' : 's were'} filed and are safe. ` : '') +
          `The ${left} remaining file${left === 1 ? ' is' : 's are'} still selected below — press the button again to continue.`,
      );
    } finally {
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('online', goOnline);
      setOffline(false);
      setUploading(false);
      setUploadProgress(0);
      setUploadFileIndex(0);
    }
  };

  const handleDelete = async (item: MyResource) => {
    if (!confirm(`Delete "${item.title}"? This can't be undone.`)) return;

    try {

      await deleteDoc(doc(db, 'resources', item.id));
      if (item.storagePath) {
        const stillUsed = await getDocs(
          query(collection(db, 'resources'), where('storagePath', '==', item.storagePath)),
        );
        if (stillUsed.empty) {
          await deleteObject(ref(storage, item.storagePath)).catch((e: any) => {

            if (e?.code !== 'storage/object-not-found') throw e;
          });
        }
      }
    } catch (err: any) {
      alert(`Could not delete: ${err.message}`);
    }
  };

  const callNumber = allBranches
    ? `${commonBranches.length === BRANCHES.length ? 'ALL BRANCHES' : commonBranches.join(' + ') || 'NO BRANCH'} · SEM ${semester} · ${type.toUpperCase()}`
    : `${branch} · SEM ${semester} · ${type.toUpperCase()}`;

  const fmtSize = (bytes: number) =>
    bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const acceptFiles = (list: FileList | null) => {
    const all = Array.from(list ?? []);
    const picked = all.filter((f) => !BLOCKED_EXT.test(f.name));
    const skipped = all.length - picked.length;
    if (picked.length) {
      setFiles(picked);
      setMessage(skipped ? `${skipped} program file${skipped === 1 ? '' : 's'} (like .exe or .apk) skipped. Everything else is fine.` : '');
    } else if (all.length) {
      setMessage('Program files like .exe, .apk or .bat cannot be filed. Any document, sheet, slide, image, zip or code file works.');
    }
  };

  return (
    <div className="res-page">
      <div className="res-head">
        <div>
          <h1>Resources</h1>
          <p>Notes, slides, assignments and previous papers — students see them in the app straight away.</p>
        </div>
        <div className="call-number" style={{ marginTop: 0 }}>{callNumber}</div>
      </div>

      <div className="res-grid">
        <div className="card res-form">

          <section className="res-step">
            <div className="res-step-head">
              <span className="res-step-num">1</span>
              <div>
                <h2>Which class</h2>
                <p>Branch, semester and section that will see it.</p>
              </div>
            </div>
            <div className="res-fields res-fields-3">
              <div>
                <label>Branch</label>
                <select value={branch} onChange={(e) => setBranch(e.target.value as typeof BRANCHES[number])} disabled={allBranches}>
                  {BRANCHES.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              </div>
              <div>
                <label>Semester</label>
                <select value={semester} onChange={(e) => setSemester(Number(e.target.value) as typeof SEMESTERS[number])}>
                  {SEMESTERS.map((s) => <option key={s} value={s}>Sem {s}</option>)}
                </select>
              </div>
              <div>
                <label>Section</label>
                <select value={section} onChange={(e) => setSection(e.target.value)} disabled={allBranches || sectionOptions.length === 0}>
                  <option value="">All sections</option>
                  {sectionOptions.map((sec) => <option key={sec} value={sec}>{sec}</option>)}
                </select>
              </div>
            </div>
            <label className="res-check">
              <input type="checkbox" checked={allBranches} onChange={(e) => setAllBranches(e.target.checked)} />
              <span>Common subject — file it for several branches</span>
            </label>
            {allBranches && (
              <div className="res-branches">
                {BRANCHES.map((b) => (
                  <label key={b} className="res-check">
                    <input
                      type="checkbox"
                      checked={commonBranches.includes(b)}
                      onChange={(e) =>
                        setCommonBranches((prev) =>
                          e.target.checked ? BRANCHES.filter((x) => x === b || prev.includes(x)) : prev.filter((x) => x !== b),
                        )
                      }
                    />
                    <span>{b}</span>
                  </label>
                ))}
              </div>
            )}
          </section>

          <section className="res-step">
            <div className="res-step-head">
              <span className="res-step-num">2</span>
              <div>
                <h2>Subject and type</h2>
                <p>Where it shows up in the student's Resources folders.</p>
              </div>
            </div>

            <div>
              <label>Subject</label>
              {allBranches ? (
                commonSubjectOptions.length > 0 ? (
                  <>
                    <select value={commonSubjectChoice} onChange={(e) => setCommonSubjectChoice(e.target.value)}>
                      {commonSubjectOptions.map((s) => (
                        <option key={s.key} value={s.key}>
                          {s.name} ({s.key})
                        </option>
                      ))}
                      <option value={OTHER_OPTION}>Other (type manually)</option>
                    </select>
                    {selectedCommon &&
                      commonBranches.some((b) => selectedCommon.perBranch[b].name !== selectedCommon.name) && (
                        <p className="res-hint">
                          Filed under each branch's own name:{' '}
                          {commonBranches.map((b) => `${b}: ${selectedCommon.perBranch[b].name}`).join(' · ')}
                        </p>
                      )}
                    {commonSubjectChoice === OTHER_OPTION && (
                      <input
                        style={{ marginTop: '0.6rem' }}
                        value={customSubject}
                        onChange={(e) => setCustomSubject(e.target.value)}
                        placeholder="e.g. Communication Skills and Personality Development"
                      />
                    )}
                  </>
                ) : (
                  <input
                    value={customSubject}
                    onChange={(e) => setCustomSubject(e.target.value)}
                    placeholder="e.g. Communication Skills and Personality Development"
                  />
                )
              ) : subjectOptions.length === 0 ? (
                <p className="res-hint">No curriculum data for this branch/semester.</p>
              ) : (
                <select value={subject} onChange={(e) => setSubject(e.target.value)}>
                  {subjectOptions.map((s) => <option key={s.code} value={s.name}>{s.code} · {s.name}</option>)}
                </select>
              )}
            </div>

            <div className="res-type-row">
              <div style={{ flex: '1 1 300px' }}>
              <label>Type</label>
              <div className="res-types" role="radiogroup" aria-label="Type">
                {TYPES.map((t) => {
                  const blocked = t === 'Assignment' && assignmentBlocked;
                  return (
                    <button
                      key={t}
                      type="button"
                      role="radio"
                      aria-checked={type === t}
                      disabled={blocked}
                      title={blocked ? 'This subject has no lab, so it has no assignments' : undefined}
                      className={`res-type${type === t ? ' res-type-on' : ''}`}
                      onClick={() => setType(t)}
                    >
                      {t === 'PYQ' ? 'Prev. papers' : t}
                    </button>
                  );
                })}
              </div>
              </div>
              {type === 'PYQ' ? (
                <div className="res-year">
                  <label>Exam year</label>
                  <select value={examYear} onChange={(e) => setExamYear(e.target.value === '' ? '' : Number(e.target.value))}>
                    <option value="">Pick year…</option>
                    {EXAM_YEARS.map((y) => <option key={y} value={y}>{y}</option>)}
                  </select>
                </div>
              ) : (
                <div className="res-year">
                  <label>Visible in</label>
                  <select value={academicYear} onChange={(e) => setAcademicYear(e.target.value)}>
                    {BATCH_CHOICES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </select>
                </div>
              )}
            </div>
            {type !== 'PYQ' && (
              <div className="res-year" style={{ marginTop: '0.8rem', maxWidth: 260 }}>
                <label>Unit</label>
                <select value={unit} onChange={(e) => setUnit(e.target.value === '' ? '' : Number(e.target.value))}>
                  <option value="">No unit</option>
                  {UNITS.map((u) => <option key={u} value={u}>Unit {u}</option>)}
                </select>
              </div>
            )}
            <p className="res-hint">
              {type !== 'PYQ' && unit !== '' && `Every file in this upload goes into the Unit ${unit} folder. `}
              {type === 'PYQ'
                ? 'Papers stay visible to every future batch, filed under the year the exam was held.'
                : type === 'Assignment'
                  ? 'Assignments are only for subjects with a lab. Students see them only during the year you choose.'
                  : "Students see this only during the year you choose — later batches won't."}
              {labStatus === 'no-lab' && ' This subject has no lab in the timetable, so Assignment is unavailable.'}
            </p>
          </section>

          <section className="res-step">
            <div className="res-step-head">
              <span className="res-step-num">3</span>
              <div>
                <h2>{source === 'link' ? 'Link' : 'File'}</h2>
                <p>{source === 'link' ? 'A Google Drive, YouTube or website link students open in their browser.' : `Any file type (PDF, Word, Excel, CSV, PowerPoint, images, zip, code), up to ${MAX_FILE_MB} MB each. Several at once is fine.`}</p>
              </div>
            </div>
            <div className="res-types" style={{ marginBottom: '0.9rem' }}>
              {(['file', 'link'] as const).map((m) => (
                <button key={m} type="button" className={`res-type${source === m ? ' res-type-on' : ''}`} onClick={() => { setSource(m); setMessage(''); }}>
                  {m === 'file' ? 'Upload files' : 'Share a link'}
                </button>
              ))}
            </div>
            {source === 'link' ? (
              <div style={{ display: 'grid', gap: '0.9rem' }}>
                <div>
                  <label>Link</label>
                  <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://drive.google.com/… or a YouTube / website link" inputMode="url" />
                  <p className="res-hint" style={{ marginTop: '0.35rem' }}>Students open it in their browser. For Google Drive, set sharing to "Anyone with the link".</p>
                </div>
                <div>
                  <label>Title</label>
                  <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Unit 3 lecture video" />
                </div>
              </div>
            ) : (
            <>
            <label
              className={`res-drop${files.length ? ' res-drop-has' : ''}`}
              onDragOver={(e) => {
                e.preventDefault();
                e.currentTarget.classList.add('res-drop-over');
              }}
              onDragLeave={(e) => e.currentTarget.classList.remove('res-drop-over')}
              onDrop={(e) => {
                e.preventDefault();
                e.currentTarget.classList.remove('res-drop-over');
                acceptFiles(e.dataTransfer.files);
              }}
            >
              <input
                type="file"
                multiple
                className="res-drop-input"
                onChange={(e) => {
                  acceptFiles(e.target.files);
                  e.target.value = '';
                }}
              />
              {files.length === 0 ? (
                <>
                  <span className="res-drop-icon" aria-hidden="true">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 15V4" /><path d="m7 9 5-5 5 5" /><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
                    </svg>
                  </span>
                  <strong>Drop files here or click to choose</strong>
                  <span>PDF, DOC/DOCX, XLS/XLSX, CSV, PPT/PPTX, images, ZIP and more</span>
                </>
              ) : (
                <div className="res-files">
                  {files.map((f) => (
                    <div key={f.name + f.size} className="res-file">
                      <span className="res-file-ext">{(f.name.split('.').pop() ?? '').toUpperCase()}</span>
                      <span className="res-file-name">{f.name}</span>
                      <span className="res-file-size">{fmtSize(f.size)}</span>
                    </div>
                  ))}
                  <span className="res-drop-change">Click to choose different files</span>
                </div>
              )}
            </label>
            {files.length > 1 ? (
              <p className="res-hint">Each file is filed as its own resource, titled from its filename.</p>
            ) : (
              <div style={{ marginTop: '0.9rem' }}>
                <label>Title</label>
                <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Unit 3 Notes" />
              </div>
            )}
            </>
            )}
          </section>

          {message && (
            <div className={`notice ${message.startsWith('Could not') || message.startsWith('Please') ? 'notice-error' : 'notice-ok'}`} role="status">
              {message}
            </div>
          )}

          <div className="res-submit">
            <button onClick={handleUpload} disabled={uploading}>
              {source === 'link'
                ? uploading ? 'Sharing…' : 'Share link'
                : uploading
                ? files.length > 1 || uploadFileIndex > 1
                  ? `Filing file ${uploadFileIndex}… ${uploadProgress}%${offline ? ' (paused)' : ''}`
                  : `Filing… ${uploadProgress}%${offline ? ' (paused)' : ''}`
                : files.length > 1
                  ? `File ${files.length} resources`
                  : 'File resource'}
            </button>
            {uploading && offline && (
              <p className="res-hint" style={{ color: '#b45309', marginTop: '0.5rem' }}>
                No internet — upload paused. It continues by itself when you're back online. Keep this tab open.
              </p>
            )}
            {uploading && (
              <div className="res-progress">
                <div style={{ width: `${uploadProgress}%` }} />
              </div>
            )}
          </div>
        </div>

        <aside className="card res-mine">
          <div className="res-mine-head">
            <h2>My uploads</h2>
            <span>{myResources.length}</span>
          </div>
          {myResourcesError && <p className="error-text">{myResourcesError}</p>}
          {!myResourcesError && myResources.length === 0 && <p className="res-hint">Nothing filed yet.</p>}
          <div className="res-mine-list">
            {myResources.map((item) => (
              <div key={item.id} className="res-mine-row">
                <div style={{ minWidth: 0 }}>
                  <div className="res-mine-title">{item.title}</div>
                  <div className="res-mine-meta">
                    {item.branch} · Sem {item.semester} · {item.isLink ? 'Link · ' : ''}{item.type === 'PYQ' ? 'Prev. paper' : item.type}{item.unit ? ` · Unit ${item.unit}` : ''}
                  </div>
                </div>
                <button className="button-secondary" onClick={() => handleDelete(item)}>Delete</button>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}

export default Upload;
