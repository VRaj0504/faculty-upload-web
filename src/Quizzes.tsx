import { getDocsCached } from './cachedCollection';
import { useEffect, useMemo, useState } from 'react';
import { addDoc, collection, deleteDoc, doc, getDocs, query, serverTimestamp, updateDoc, where } from 'firebase/firestore';
import { auth, db } from './firebaseConfig';
import { loadRoster, type RosterRow } from './examData';
import { subjectsFor } from './curriculum';
import { roomKey, splitRooms } from './roomNames';

type Room = { room: string; fromRegNo: string; toRegNo: string };
type Quiz = {
  id: string;
  title: string;
  subjectCode: string;
  subjectName: string;
  branch: string;
  admissionYear: number;
  sections: string[];
  date: string;
  startTime: string;
  endTime: string;
  syllabus: string;
  rooms: Room[];
  note?: string | null;
  createdBy: string;
  createdByName?: string | null;
};

const TIMES = Array.from({ length: 25 }, (_, i) => {
  const m = 8 * 60 + i * 30;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
});
const to12h = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
};
const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
function currentSemester(admissionYear: number): number {
  const now = new Date();
  const odd = now.getMonth() + 1 >= 7;
  const idx = odd ? now.getFullYear() - admissionYear : now.getFullYear() - admissionYear - 1;
  return Math.min(Math.max(idx * 2 + (odd ? 1 : 2), 1), 8);
}

const EMPTY = {
  batch: '',
  branch: '',
  sections: [] as string[],
  semester: '',
  subjectCode: '',
  title: '',
  date: '',
  startTime: '10:00',
  endTime: '11:00',
  syllabus: '',
  note: '',
  rooms: [] as Room[],
};

export default function Quizzes({ canManageAll }: { canManageAll: boolean }) {
  const uid = auth.currentUser?.uid ?? '';
  const [roster, setRoster] = useState<RosterRow[]>([]);
  const [rooms, setRooms] = useState<string[]>([]);
  const [quizzes, setQuizzes] = useState<Quiz[] | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [editing, setEditing] = useState<string | null>(null);
  const [subjects, setSubjects] = useState<{ code: string; name: string }[]>([]);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = async () => {
    const snap = await getDocs(query(collection(db, 'quizzes'), where('date', '>=', todayIso())));
    setQuizzes(
      snap.docs
        .map((d) => ({ id: d.id, ...(d.data() as Omit<Quiz, 'id'>) }))
        .filter((q) => canManageAll || q.createdBy === uid)
        .sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime)),
    );
  };

  useEffect(() => {
    loadRoster().then(setRoster).catch(() => setRoster([]));
    getDocsCached('timetable')
      .then((snap) => {
        const byKey = new Map<string, string>();
        snap.docs.forEach((d) => {
          const days = (d.data().days ?? []) as { slots?: { room?: string }[] }[];
          days.forEach((day) =>
            (day.slots ?? []).forEach((s) =>
              splitRooms(s.room ?? '').forEach((r) => {
                const k = roomKey(r);
                if (k && /\d/.test(r) && !byKey.has(k)) byKey.set(k, r);
              }),
            ),
          );
        });
        setRooms(Array.from(byKey.values()).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })));
      })
      .catch(() => setRooms([]));
    reload().catch((e) => setStatus(`Couldn't load quizzes: ${e.message}`));
  }, []);

  const batches = useMemo(() => Array.from(new Set(roster.map((r) => r.admissionYear))).filter(Boolean).sort((a, b) => b - a), [roster]);
  const branches = useMemo(
    () => Array.from(new Set(roster.filter((r) => String(r.admissionYear) === form.batch).map((r) => r.branch))).filter(Boolean).sort(),
    [roster, form.batch],
  );
  const sectionOptions = useMemo(
    () =>
      Array.from(
        new Set(roster.filter((r) => String(r.admissionYear) === form.batch && r.branch === form.branch).map((r) => r.section ?? '')),
      )
        .filter(Boolean)
        .sort(),
    [roster, form.batch, form.branch],
  );
  const students = useMemo(
    () =>
      roster
        .filter((r) => String(r.admissionYear) === form.batch && r.branch === form.branch)
        .filter((r) => form.sections.length === 0 || form.sections.includes(r.section ?? ''))
        .map((r) => r.regNo)
        .sort(),
    [roster, form.batch, form.branch, form.sections],
  );

  useEffect(() => {
    if (!form.branch || !form.semester) {
      setSubjects([]);
      return;
    }
    const sem = Number(form.semester);
    getDocs(query(collection(db, 'curriculum'), where('branch', '==', form.branch), where('semester', '==', sem)))
      .then((snap) => {
        const live = snap.docs.map((d) => ({ code: d.data().code as string, name: d.data().name as string }));
        setSubjects((live.length ? live : subjectsFor(form.branch, sem)).sort((a, b) => a.code.localeCompare(b.code)));
      })
      .catch(() => setSubjects(subjectsFor(form.branch, sem)));
  }, [form.branch, form.semester]);

  const set = <K extends keyof typeof EMPTY>(k: K, v: (typeof EMPTY)[K]) => setForm((f) => ({ ...f, [k]: v }));
  const setRoom = (i: number, patch: Partial<Room>) =>
    setForm((f) => ({ ...f, rooms: f.rooms.map((r, j) => (j === i ? { ...r, ...patch } : r)) }));

  const splitEvenly = () => {
    const n = form.rooms.length;
    if (n === 0 || students.length === 0) return;
    const per = Math.ceil(students.length / n);
    setForm((f) => ({
      ...f,
      rooms: f.rooms.map((r, i) => {
        const chunk = students.slice(i * per, (i + 1) * per);
        return chunk.length ? { ...r, fromRegNo: chunk[0], toRegNo: chunk[chunk.length - 1] } : { ...r, fromRegNo: '', toRegNo: '' };
      }),
    }));
  };

  const covered = useMemo(() => {
    const ok = form.rooms.filter((r) => r.room && r.fromRegNo && r.toRegNo);
    return students.filter((s) => ok.some((r) => s >= r.fromRegNo && s <= r.toRegNo)).length;
  }, [form.rooms, students]);

  const save = async () => {
    const subject = subjects.find((s) => s.code === form.subjectCode);
    if (!form.batch || !form.branch || !subject || !form.date) {
      setStatus('Pick the batch, branch, subject and date first.');
      return;
    }
    if (form.endTime <= form.startTime) {
      setStatus('The end time must be after the start time.');
      return;
    }
    const roomsClean = form.rooms.filter((r) => r.room && r.fromRegNo && r.toRegNo);
    if (roomsClean.some((r) => r.fromRegNo > r.toRegNo)) {
      setStatus('In each room, the first enrollment number must come before the last one.');
      return;
    }
    setBusy(true);
    setStatus('Saving…');
    const data = {
      title: form.title.trim(),
      subjectCode: subject.code,
      subjectName: subject.name,
      branch: form.branch,
      admissionYear: Number(form.batch),
      sections: form.sections,
      date: form.date,
      startTime: form.startTime,
      endTime: form.endTime,
      syllabus: form.syllabus.trim(),
      note: form.note.trim() || null,
      rooms: roomsClean,
      updatedAt: serverTimestamp(),
    };
    try {
      if (editing) {
        const existing = quizzes?.find((q) => q.id === editing);
        await updateDoc(doc(db, 'quizzes', editing), { ...data, createdBy: existing?.createdBy ?? uid });
      } else {
        await addDoc(collection(db, 'quizzes'), {
          ...data,
          createdBy: uid,
          createdByName: auth.currentUser?.displayName ?? auth.currentUser?.email ?? null,
          createdAt: serverTimestamp(),
        });
      }
      setStatus(editing ? 'Quiz updated. Students were notified of the change.' : 'Quiz posted. Students have been notified.');
      setForm(EMPTY);
      setEditing(null);
      await reload();
    } catch (e: any) {
      setStatus(`Couldn't save: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const edit = (q: Quiz) => {
    setEditing(q.id);
    setForm({
      batch: String(q.admissionYear),
      branch: q.branch,
      sections: q.sections ?? [],
      semester: String(currentSemester(q.admissionYear)),
      subjectCode: q.subjectCode,
      title: q.title ?? '',
      date: q.date,
      startTime: q.startTime,
      endTime: q.endTime,
      syllabus: q.syllabus ?? '',
      note: q.note ?? '',
      rooms: q.rooms ?? [],
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const remove = async (q: Quiz) => {
    if (!confirm(`Delete "${q.title || q.subjectName}" on ${q.date}? Students will no longer see it.`)) return;
    await deleteDoc(doc(db, 'quizzes', q.id)).catch((e) => alert(`Couldn't delete: ${e.message}`));
    await reload();
  };

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: '1rem 0 3rem' }}>
      <h1 style={{ fontSize: '1.5rem', margin: '0 0 0.3rem' }}>{editing ? 'Edit quiz' : 'Schedule a quiz'}</h1>
      <p style={{ color: 'var(--ink-soft)', margin: '0 0 1rem', fontSize: '0.9rem' }}>
        Students of the batch get a notification with the date, time and their own room, and see the syllabus in the app.
      </p>

      <div className="card" style={{ padding: '1.2rem 1.4rem' }}>
        <div className="att-row" style={{ marginTop: 0 }}>
          <div className="att-field">
            <label>Batch (admission year)</label>
            <select
              value={form.batch}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  batch: e.target.value,
                  branch: '',
                  sections: [],
                  subjectCode: '',
                  rooms: [],
                  semester: e.target.value ? String(currentSemester(Number(e.target.value))) : '',
                }))
              }
            >
              <option value="">Select…</option>
              {batches.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
          <div className="att-field">
            <label>Branch</label>
            <select value={form.branch} disabled={!form.batch} onChange={(e) => setForm((f) => ({ ...f, branch: e.target.value, sections: [], subjectCode: '', rooms: [] }))}>
              <option value="">Select…</option>
              {branches.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>
          <div className="att-field">
            <label>Semester</label>
            <select value={form.semester} disabled={!form.batch} onChange={(e) => setForm((f) => ({ ...f, semester: e.target.value, subjectCode: '' }))}>
              <option value="">Select…</option>
              {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => <option key={n} value={n}>Semester {n}</option>)}
            </select>
          </div>
        </div>

        {sectionOptions.length > 1 && (
          <div style={{ marginTop: '0.8rem' }}>
            <label>Sections (leave all unticked for the whole batch)</label>
            <div style={{ display: 'flex', gap: '0.8rem', flexWrap: 'wrap', marginTop: '0.3rem' }}>
              {sectionOptions.map((s) => (
                <label key={s} style={{ display: 'flex', gap: '0.3rem', alignItems: 'center', fontWeight: 500 }}>
                  <input
                    type="checkbox"
                    checked={form.sections.includes(s)}
                    onChange={(e) => set('sections', e.target.checked ? [...form.sections, s] : form.sections.filter((x) => x !== s))}
                  />
                  {s}
                </label>
              ))}
            </div>
          </div>
        )}

        <div className="att-row">
          <div className="att-field" style={{ flexBasis: 320 }}>
            <label>Subject</label>
            <select value={form.subjectCode} disabled={subjects.length === 0} onChange={(e) => set('subjectCode', e.target.value)}>
              <option value="">{subjects.length ? 'Select…' : 'Pick batch, branch and semester'}</option>
              {subjects.map((s) => <option key={s.code} value={s.code}>{s.code} · {s.name}</option>)}
            </select>
          </div>
          <div className="att-field">
            <label>Quiz name (optional)</label>
            <select value={form.title} onChange={(e) => set('title', e.target.value)}>
              <option value="">Quiz</option>
              {['Quiz 1', 'Quiz 2', 'Quiz 3', 'Quiz 4', 'Surprise test', 'Lab quiz', 'Viva'].map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
        </div>

        <div className="att-row">
          <div className="att-field">
            <label>Date</label>
            <input type="date" min={todayIso()} value={form.date} onChange={(e) => set('date', e.target.value)} />
          </div>
          <div className="att-field">
            <label>Starts</label>
            <select value={form.startTime} onChange={(e) => set('startTime', e.target.value)}>
              {TIMES.map((t) => <option key={t} value={t}>{to12h(t)}</option>)}
            </select>
          </div>
          <div className="att-field">
            <label>Ends</label>
            <select value={form.endTime} onChange={(e) => set('endTime', e.target.value)}>
              {TIMES.map((t) => <option key={t} value={t}>{to12h(t)}</option>)}
            </select>
          </div>
        </div>

        <div style={{ marginTop: '0.8rem' }}>
          <label>Syllabus</label>
          <textarea
            rows={3}
            value={form.syllabus}
            maxLength={4000}
            placeholder="e.g. Units 1–2: arrays, linked lists, stacks"
            onChange={(e) => set('syllabus', e.target.value)}
            style={{ width: '100%' }}
          />
        </div>

        <div style={{ marginTop: '1rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
            <label style={{ margin: 0 }}>
              Seating {students.length > 0 && <span style={{ color: 'var(--ink-soft)', fontWeight: 400 }}>· {covered} of {students.length} students placed</span>}
            </label>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button
                type="button"
                className="button-secondary"
                disabled={!form.branch}
                onClick={() => set('rooms', [...form.rooms, { room: '', fromRegNo: '', toRegNo: '' }])}
              >
                Add room
              </button>
              <button type="button" className="button-secondary" disabled={form.rooms.length === 0 || students.length === 0} onClick={splitEvenly}>
                Split students evenly
              </button>
            </div>
          </div>
          {form.rooms.map((r, i) => (
            <div className="att-row" key={i} style={{ alignItems: 'flex-end' }}>
              <div className="att-field">
                <label>Room</label>
                <select value={r.room} onChange={(e) => setRoom(i, { room: e.target.value })}>
                  <option value="">Select…</option>
                  {rooms.map((x) => <option key={x} value={x}>{x}</option>)}
                </select>
              </div>
              <div className="att-field">
                <label>From</label>
                <select value={r.fromRegNo} onChange={(e) => setRoom(i, { fromRegNo: e.target.value })}>
                  <option value="">Select…</option>
                  {students.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div className="att-field">
                <label>To</label>
                <select value={r.toRegNo} onChange={(e) => setRoom(i, { toRegNo: e.target.value })}>
                  <option value="">Select…</option>
                  {students.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <button type="button" className="button-secondary" onClick={() => set('rooms', form.rooms.filter((_, j) => j !== i))}>
                Remove
              </button>
            </div>
          ))}
          {form.rooms.length === 0 && (
            <p className="res-hint">Optional. Add rooms to tell each student where to sit, or leave empty if it's in the usual classroom.</p>
          )}
        </div>

        <div style={{ marginTop: '0.8rem' }}>
          <label>Note for students (optional)</label>
          <input value={form.note} maxLength={300} placeholder="e.g. Bring a calculator" onChange={(e) => set('note', e.target.value)} />
        </div>

        <div style={{ display: 'flex', gap: '0.6rem', marginTop: '1.2rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <button disabled={busy} onClick={save}>{editing ? 'Save changes' : 'Post quiz'}</button>
          {editing && (
            <button className="button-secondary" onClick={() => { setEditing(null); setForm(EMPTY); setStatus(''); }}>
              Cancel
            </button>
          )}
          {status && <span className="res-hint" style={{ margin: 0 }}>{status}</span>}
        </div>
      </div>

      <h2 style={{ fontSize: '1.1rem', margin: '1.6rem 0 0.6rem' }}>{canManageAll ? 'Upcoming quizzes' : 'Your upcoming quizzes'}</h2>
      {quizzes === null ? (
        <p className="res-hint">Loading…</p>
      ) : quizzes.length === 0 ? (
        <p className="res-hint">None scheduled.</p>
      ) : (
        quizzes.map((q) => (
          <div key={q.id} className="card" style={{ padding: '0.9rem 1.1rem', marginBottom: '0.6rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.6rem', flexWrap: 'wrap' }}>
              <div>
                <strong>{q.title || 'Quiz'} · {q.subjectCode} {q.subjectName}</strong>
                <div style={{ color: 'var(--ink-soft)', fontSize: '0.85rem' }}>
                  {q.branch} {q.admissionYear}{q.sections?.length ? ` (${q.sections.join(', ')})` : ''} · {q.date} · {to12h(q.startTime)}–{to12h(q.endTime)}
                  {q.rooms?.length ? ` · ${q.rooms.map((r) => r.room).join(', ')}` : ''}
                </div>
              </div>
              {(canManageAll || q.createdBy === uid) && (
                <div style={{ display: 'flex', gap: '0.4rem' }}>
                  <button className="button-secondary" onClick={() => edit(q)}>Edit</button>
                  <button className="button-secondary" onClick={() => remove(q)}>Delete</button>
                </div>
              )}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
