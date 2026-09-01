import { useState, useEffect } from 'react';
import { collection, addDoc, serverTimestamp, query, where, orderBy, onSnapshot, deleteDoc, doc } from 'firebase/firestore';
import { ref, uploadBytesResumable, getDownloadURL, deleteObject } from 'firebase/storage';
import { auth, db, storage } from './firebaseConfig';
import { curriculum } from './curriculum';

const BRANCHES = ['CSE', 'ECE', 'MNC'] as const;
const SEMESTERS = [1, 2, 3, 4, 5, 6, 7, 8] as const;
const TYPES = ['Notes', 'PYQ', 'Slides'] as const;
// Keeps a sane cap on file size regardless of what the backend allows —
// checking this client-side means a faculty member filing an oversized
// deck gets a clear message immediately, instead of waiting through
// however long the upload takes only to hit a cryptic storage-layer
// error at the end.
const MAX_FILE_MB = 50;

type MyResource = {
  id: string;
  title: string;
  subject: string;
  branch: string;
  semester: number;
  type: string;
  storagePath: string;
};

function Upload() {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [branch, setBranch] = useState<typeof BRANCHES[number]>('CSE');
  const [allBranches, setAllBranches] = useState(false);
  const [semester, setSemester] = useState<typeof SEMESTERS[number]>(1);
  const [subject, setSubject] = useState('');
  const [customSubject, setCustomSubject] = useState('');
  const [type, setType] = useState<typeof TYPES[number]>('Notes');
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [message, setMessage] = useState('');
  const [myResources, setMyResources] = useState<MyResource[]>([]);
  const [myResourcesError, setMyResourcesError] = useState('');

  // Depends on branch + semester. When "applies to all branches" is checked,
  // different branches can have different curricula for the same semester,
  // so there's no single dropdown that's correct for all of them — the
  // faculty types the subject name directly instead (matched by name, not
  // code, everywhere else in the app anyway).
  const subjectOptions = curriculum[branch]?.[semester] ?? [];

  useEffect(() => {
    if (allBranches) return;
    if (subjectOptions.length > 0 && !subjectOptions.some((s) => s.name === subject)) {
      setSubject(subjectOptions[0].name);
    } else if (subjectOptions.length === 0) {
      setSubject('');
    }
  }, [branch, semester, allBranches]);

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
        // A `where` + `orderBy` on different fields needs a composite
        // Firestore index. The first time this query runs, Firebase logs a
        // console error with a direct "create it" link — surfacing that
        // here instead of failing silently, like it did before.
        console.error('My Uploads query failed:', err);
        setMyResourcesError(
          'Could not load your uploads. Open the browser console (F12) — Firebase usually prints a link there to create a missing index; click it, wait a minute, then reload.'
        );
      }
    );

    return () => unsubscribe();
  }, []);

  const handleUpload = async () => {
    const effectiveSubject = allBranches ? customSubject.trim() : subject;
    if (!file || !title || !effectiveSubject) {
      setMessage('Please fill in all fields and choose a file.');
      return;
    }
    if (file.size > MAX_FILE_MB * 1024 * 1024) {
      setMessage(
        `"${file.name}" is ${(file.size / (1024 * 1024)).toFixed(1)}MB — the limit here is ${MAX_FILE_MB}MB. Try compressing it, or splitting it into parts.`,
      );
      return;
    }
    setUploading(true);
    setUploadProgress(0);
    setMessage('');
    try {
      const targetBranches = allBranches ? BRANCHES : [branch];

      // Upload the actual file once; if it's common to all branches, we
      // don't need three copies of the same file, just three metadata
      // records (one per branch) pointing at it — that's how each
      // branch's Resources screen finds it, since it filters by branch.
      // Nested under resources/ to match the storage.rules path the
      // mobile app's uploads also use.
      const storagePath = `resources/${allBranches ? 'ALL' : branch}/${semester}/${effectiveSubject}/${Date.now()}-${file.name}`;

      // cacheControl caches this file for a year — safe because
      // storagePath embeds Date.now(), so a given path's content never
      // changes. Without this, every student opening a shared PYQ/notes
      // file re-pulls it from origin storage instead of a cached edge
      // copy — the fastest way to burn through bandwidth during
      // exam-week download spikes across a whole college.
      const fileRef = ref(storage, storagePath);

      // uploadBytesResumable instead of uploadBytes + a manual
      // file.arrayBuffer() read: it streams the File directly (no
      // upfront full-file read blocking the start of the upload),
      // uploads in chunks with automatic retry on transient network
      // failures (rather than the whole thing failing outright on one
      // hiccup), and exposes real progress — all three of which were
      // missing before and are almost certainly why uploads felt slow
      // and unreliable on typical college wifi.
      const fileUrl = await new Promise<string>((resolve, reject) => {
        const uploadTask = uploadBytesResumable(fileRef, file, {
          contentType: file.type,
          cacheControl: 'public,max-age=31536000,immutable',
        });
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

      await Promise.all(
        targetBranches.map((b) =>
          addDoc(collection(db, 'resources'), {
            title,
            subject: effectiveSubject,
            branch: b,
            semester,
            type,
            fileUrl,
            uploadedBy: auth.currentUser?.uid,
            storagePath,
            uploadedByName: auth.currentUser?.email,
            createdAt: serverTimestamp(),
          })
        )
      );

      setMessage(
        allBranches
          ? `Filed successfully for all branches (${BRANCHES.join(', ')}).`
          : 'Filed successfully.'
      );
      setFile(null);
      setTitle('');
      setCustomSubject('');
    } catch (err: any) {
      setMessage(`Could not file this item: ${err.message}`);
    } finally {
      setUploading(false);
      setUploadProgress(0);
    }
  };

  const handleDelete = async (item: MyResource) => {
    if (!confirm(`Delete "${item.title}"? This can't be undone.`)) return;

    try {
      await deleteObject(ref(storage, item.storagePath));
      await deleteDoc(doc(db, 'resources', item.id));
    } catch (err: any) {
      alert(`Could not delete: ${err.message}`);
    }
  };

  const callNumber = allBranches
    ? `ALL BRANCHES · SEM ${semester} · ${type.toUpperCase()}`
    : `${branch} · SEM ${semester} · ${type.toUpperCase()}`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '2rem 0' }}>
      <div className="card" style={{ width: 440, padding: '2.5rem 2.5rem 2rem' }}>
        <h1 style={{ fontSize: '1.5rem' }}>File a Resource</h1>

        <div className="call-number">{callNumber}</div>

        <div style={{ marginTop: '1.6rem' }}>
          <label>File (PDF or PPT)</label>
          <input
            type="file"
            accept=".pdf,.ppt,.pptx"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </div>

        <div style={{ marginTop: '1.1rem' }}>
          <label>Title</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Unit 3 Notes" />
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '1.1rem', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={allBranches}
            onChange={(e) => setAllBranches(e.target.checked)}
            style={{ width: 'auto', flexShrink: 0 }}
          />
          <span>This is a common subject — file it for all branches</span>
        </label>

        {/* Branch + Semester come BEFORE Subject, since Subject depends on both */}
        <div style={{ display: 'flex', gap: '0.8rem', marginTop: '1.1rem' }}>
          <div style={{ flex: 1 }}>
            <label>Branch</label>
            <select value={branch} onChange={(e) => setBranch(e.target.value as typeof BRANCHES[number])} disabled={allBranches}>
              {BRANCHES.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <label>Semester</label>
            <select value={semester} onChange={(e) => setSemester(Number(e.target.value) as typeof SEMESTERS[number])}>
              {SEMESTERS.map((s) => <option key={s} value={s}>Sem {s}</option>)}
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <label>Type</label>
            <select value={type} onChange={(e) => setType(e.target.value as typeof TYPES[number])}>
              {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
        </div>

        {/* Subject — dropdown from curriculum.ts for a single branch, or
            free text when filing for all branches at once. */}
        <div style={{ marginTop: '1.1rem' }}>
          <label>Subject</label>
          {allBranches ? (
            <input
              value={customSubject}
              onChange={(e) => setCustomSubject(e.target.value)}
              placeholder="e.g. Communication Skills and Personality Development"
            />
          ) : subjectOptions.length === 0 ? (
            <p style={{ color: 'var(--ink-soft)', fontSize: '0.85rem' }}>No curriculum data for this branch/semester.</p>
          ) : (
            <select value={subject} onChange={(e) => setSubject(e.target.value)}>
              {subjectOptions.map((s) => <option key={s.code} value={s.name}>{s.name}</option>)}
            </select>
          )}
        </div>

        {message && (
          <p className={message.startsWith('Could not') ? 'error-text' : 'success-text'} style={{ marginTop: '1rem' }}>
            {message}
          </p>
        )}

        <button onClick={handleUpload} disabled={uploading} style={{ width: '100%', marginTop: '1.4rem' }}>
          {uploading ? `Filing… ${uploadProgress}%` : 'File Resource'}
        </button>

        {uploading && (
          <div style={{ marginTop: '0.6rem', height: 6, borderRadius: 3, backgroundColor: 'var(--line)', overflow: 'hidden' }}>
            <div
              style={{
                width: `${uploadProgress}%`,
                height: '100%',
                backgroundColor: 'var(--accent)',
                transition: 'width 0.2s ease',
              }}
            />
          </div>
        )}
      </div>

      <div className="card" style={{ width: 440, padding: '2rem 2.5rem', marginTop: '1.5rem' }}>
        <p className="eyebrow">My Uploads</p>
        {myResourcesError && <p className="error-text">{myResourcesError}</p>}
        {!myResourcesError && myResources.length === 0 && <p style={{ color: 'var(--ink-soft)' }}>Nothing filed yet.</p>}
        {myResources.map((item) => (
          <div
            key={item.id}
            className="list-row"
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '0.7rem 0',
              borderBottom: '1px solid var(--line)',
            }}
          >
            <div>
              <div style={{ fontWeight: 500 }}>{item.title}</div>
              <div className="eyebrow" style={{ fontSize: '0.65rem' }}>
                {item.branch} · SEM {item.semester} · {item.type}
              </div>
            </div>
            <button className="button-secondary" onClick={() => handleDelete(item)}>Delete</button>
          </div>
        ))}
      </div>
    </div>
  );
}

export default Upload;
