import { useEffect, useMemo, useState } from 'react';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
  type Timestamp,
} from 'firebase/firestore';
import { auth, db } from './firebaseConfig';
import { getDocsCached } from './cachedCollection';
import { VENUES } from './examVenues';

type RosterEntry = { regNo: string; name?: string; branch?: string; section?: string | null; admissionYear?: number; program?: 'UG' | 'PG' };
type Faculty = { uid: string; name: string; email: string; department: string; designation: string };

export type Meeting = {
  id: string;
  title: string;
  agenda?: string;
  date: string;
  startTime: string;
  endTime?: string | null;
  venue: string;
  status: 'scheduled' | 'cancelled';
  audience: {
    students: { admissionYears: number[]; branches: string[]; sections: string[]; regNos: string[] } | null;
    faculty: { departments: string[]; emails: string[] } | null;
  };
  audienceLabel: string;
  createdBy: string;
  createdByName: string;
  createdAt?: Timestamp | null;
  recipientCount?: number;
  recipientUids?: string[];
};

type Ack = { id: string; name: string; role?: string; at?: Timestamp | null };

const MEETING_PLACES = ["Director's office", 'Conference room', 'Board room', 'Seminar hall', 'Auditorium', 'Online (link in agenda)'];
const PLACES = [...MEETING_PLACES, ...(VENUES as readonly string[]).filter((v) => !MEETING_PLACES.includes(v))];

const TIMES = Array.from({ length: 25 }, (_, i) => {
  const m = 8 * 60 + i * 30;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
});

export const clock = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
};

export const whenLabel = (m: Pick<Meeting, 'date' | 'startTime' | 'endTime'>) => {
  const d = new Date(`${m.date}T00:00:00`);
  return `${d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}, ${clock(m.startTime)}${m.endTime ? ` – ${clock(m.endTime)}` : ''}`;
};

const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const isPg = (e: RosterEntry) => e.program === 'PG' || /^PG/i.test(e.regNo);
const yearLabel = (year: number, pg: boolean) => {
  const now = new Date();
  const start = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
  const y = start - year + 1;
  const ord = y === 1 ? '1st' : y === 2 ? '2nd' : y === 3 ? '3rd' : `${y}th`;
  return `${pg ? 'M.Tech' : 'B.Tech'} ${ord} year (${year})`;
};

function VenuePicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const known = PLACES.includes(value);
  const [other, setOther] = useState(!!value && !known);
  return (
    <>
      <select
        value={other ? '__other__' : value}
        onChange={(e) => {
          if (e.target.value === '__other__') {
            setOther(true);
            onChange('');
          } else {
            setOther(false);
            onChange(e.target.value);
          }
        }}
      >
        <option value="" disabled>Choose a place</option>
        <optgroup label="Meeting places">
          {MEETING_PLACES.map((p) => <option key={p} value={p}>{p}</option>)}
        </optgroup>
        <optgroup label="Classrooms and labs">
          {PLACES.filter((p) => !MEETING_PLACES.includes(p)).map((p) => <option key={p} value={p}>{p}</option>)}
        </optgroup>
        <option value="__other__">Other…</option>
      </select>
      {other && <input style={{ marginTop: 6 }} placeholder="Type the place" value={value} onChange={(e) => onChange(e.target.value)} />}
    </>
  );
}

function MeetingRow({ m, mine }: { m: Meeting; mine: boolean }) {
  const [acks, setAcks] = useState<Ack[] | null>(null);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [date, setDate] = useState(m.date);
  const [start, setStart] = useState(m.startTime);
  const [end, setEnd] = useState(m.endTime ?? '');
  const [venue, setVenue] = useState(m.venue);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(
    () =>
      onSnapshot(
        collection(db, 'meetings', m.id, 'acks'),
        (s) => setAcks(s.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Ack, 'id'>) }))),
        () => setAcks([]),
      ),
    [m.id],
  );

  const past = m.date < todayIso();
  const cancelled = m.status === 'cancelled';
  const sent = m.recipientCount;

  const save = async () => {
    if (!date || !start || !venue.trim()) return setErr('Date, start time and place are needed.');
    if (end && end <= start) return setErr('End time must be after the start time.');
    setBusy(true);
    setErr('');
    try {
      await updateDoc(doc(db, 'meetings', m.id), { date, startTime: start, endTime: end || null, venue: venue.trim(), updatedAt: serverTimestamp() });
      setEditing(false);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!confirm(`Cancel "${m.title}"? Everyone invited gets a notification.`)) return;
    setBusy(true);
    try {
      await updateDoc(doc(db, 'meetings', m.id), { status: 'cancelled', updatedAt: serverTimestamp() });
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirm('Remove this meeting from the list? Nobody is notified.')) return;
    await deleteDoc(doc(db, 'meetings', m.id)).catch((e) => setErr(e.message));
  };

  return (
    <div className={`mt-row${cancelled ? ' is-cancelled' : ''}${past ? ' is-past' : ''}`}>
      <div className="mt-date">
        <span>{new Date(`${m.date}T00:00:00`).toLocaleDateString('en-IN', { month: 'short' })}</span>
        <b>{Number(m.date.slice(8))}</b>
      </div>
      <div className="mt-body">
        <div className="mt-title">
          {m.title}
          {cancelled && <span className="mt-tag mt-tag-red">Cancelled</span>}
        </div>
        <div className="mt-meta">{whenLabel(m)} · {m.venue}</div>
        <div className="mt-meta">For {m.audienceLabel}</div>
        <div className="mt-stats">
          <span>{sent === undefined ? 'Sending…' : `Sent to ${sent}`}</span>
          <button type="button" className="mt-link" onClick={() => setOpen(!open)} disabled={!acks?.length}>
            {acks === null ? '…' : `${acks.length} confirmed`}{acks?.length ? (open ? ' ▴' : ' ▾') : ''}
          </button>
        </div>
        {open && acks && acks.length > 0 && (
          <div className="mt-acks">
            {[...acks].sort((a, b) => a.name.localeCompare(b.name)).map((a) => (
              <span key={a.id} className="mt-ack">{a.name}{a.role === 'faculty' ? ' · faculty' : ''}</span>
            ))}
          </div>
        )}
        {m.agenda && <p className="mt-agenda">{m.agenda}</p>}
        {editing && (
          <div className="mt-edit">
            <div><label>Date</label><input type="date" min={todayIso()} value={date} onChange={(e) => setDate(e.target.value)} /></div>
            <div>
              <label>Starts</label>
              <select value={start} onChange={(e) => setStart(e.target.value)}>{TIMES.map((t) => <option key={t} value={t}>{clock(t)}</option>)}</select>
            </div>
            <div>
              <label>Ends</label>
              <select value={end} onChange={(e) => setEnd(e.target.value)}>
                <option value="">Not set</option>
                {TIMES.filter((t) => t > start).map((t) => <option key={t} value={t}>{clock(t)}</option>)}
              </select>
            </div>
            <div className="mt-edit-wide"><label>Place</label><VenuePicker value={venue} onChange={setVenue} /></div>
          </div>
        )}
        {err && <p className="error-text">{err}</p>}
        {mine && (
          <div className="mt-actions">
            {!cancelled && !past && !editing && <button type="button" className="button-secondary" onClick={() => setEditing(true)}>Change time or place</button>}
            {editing && <button type="button" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save and notify'}</button>}
            {editing && <button type="button" className="button-secondary" onClick={() => setEditing(false)}>Back</button>}
            {!cancelled && !past && !editing && <button type="button" className="button-secondary mt-danger" onClick={cancel} disabled={busy}>Cancel meeting</button>}
            {(cancelled || past) && <button type="button" className="button-secondary" onClick={remove}>Remove</button>}
          </div>
        )}
      </div>
    </div>
  );
}

export default function Meetings({ myName }: { myName: string }) {
  const [roster, setRoster] = useState<RosterEntry[] | null>(null);
  const [faculty, setFaculty] = useState<Faculty[] | null>(null);
  const [list, setList] = useState<Meeting[] | null>(null);

  const [title, setTitle] = useState('');
  const [withStudents, setWithStudents] = useState(true);
  const [withFaculty, setWithFaculty] = useState(false);
  const [studentMode, setStudentMode] = useState<'group' | 'specific'>('group');
  const [batch, setBatch] = useState('');
  const [branch, setBranch] = useState('');
  const [section, setSection] = useState('');
  const [regText, setRegText] = useState('');
  const [facultyMode, setFacultyMode] = useState<'all' | 'department' | 'specific'>('all');
  const [dept, setDept] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [facultySearch, setFacultySearch] = useState('');
  const [date, setDate] = useState('');
  const [start, setStart] = useState('11:00');
  const [end, setEnd] = useState('');
  const [venue, setVenue] = useState("Director's office");
  const [agenda, setAgenda] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const [tab, setTab] = useState<'upcoming' | 'past'>('upcoming');

  useEffect(() => {
    getDocsCached('roster')
      .then((s) => setRoster(s.docs.filter((d) => d.data().reviewer !== true).map((d) => ({ ...(d.data() as Omit<RosterEntry, 'regNo'>), regNo: d.id.toUpperCase() }))))
      .catch(() => setRoster([]));
    getDocs(query(collection(db, 'users'), where('role', '==', 'faculty')))
      .then((s) =>
        setFaculty(
          s.docs
            .map((d) => {
              const x = d.data();
              return { uid: d.id, name: String(x.name ?? x.email ?? ''), email: String(x.email ?? '').toLowerCase(), department: String(x.department ?? ''), designation: String(x.designation ?? '') };
            })
            .filter((f) => f.uid !== auth.currentUser?.uid && f.name)
            .sort((a, b) => a.name.replace(/^(dr|prof|mr|ms|mrs)\.?\s+/i, '').localeCompare(b.name.replace(/^(dr|prof|mr|ms|mrs)\.?\s+/i, ''))),
        ),
      )
      .catch(() => setFaculty([]));
    return onSnapshot(
      query(collection(db, 'meetings'), orderBy('date', 'desc'), limit(60)),
      (s) => setList(s.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Meeting, 'id'>) }))),
      () => setList([]),
    );
  }, []);

  const batches = useMemo(() => {
    const m = new Map<string, { key: string; year: number; pg: boolean }>();
    (roster ?? []).forEach((e) => {
      if (typeof e.admissionYear !== 'number') return;
      const pg = isPg(e);
      const key = `${e.admissionYear}|${pg ? 'PG' : 'UG'}`;
      if (!m.has(key)) m.set(key, { key, year: e.admissionYear, pg });
    });
    return Array.from(m.values()).sort((a, b) => b.year - a.year || Number(a.pg) - Number(b.pg));
  }, [roster]);

  const inBatch = (e: RosterEntry) => !batch || `${e.admissionYear}|${isPg(e) ? 'PG' : 'UG'}` === batch;
  const branches = useMemo(() => Array.from(new Set((roster ?? []).filter(inBatch).map((e) => e.branch).filter(Boolean) as string[])).sort(), [roster, batch]);
  const sections = useMemo(
    () => Array.from(new Set((roster ?? []).filter((e) => inBatch(e) && (!branch || e.branch === branch)).map((e) => e.section).filter(Boolean) as string[])).sort(),
    [roster, batch, branch],
  );

  const regNos = useMemo(() => Array.from(new Set(regText.toUpperCase().split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean))), [regText]);
  const rosterSet = useMemo(() => new Set((roster ?? []).map((e) => e.regNo)), [roster]);
  const unknownRegs = regNos.filter((r) => !rosterSet.has(r));

  const studentReach = useMemo(() => {
    if (!withStudents || !roster) return 0;
    if (studentMode === 'specific') return regNos.filter((r) => rosterSet.has(r)).length;
    return roster.filter((e) => inBatch(e) && (!branch || e.branch === branch) && (!section || e.section === section)).length;
  }, [withStudents, roster, studentMode, regNos, rosterSet, batch, branch, section]);

  const departments = useMemo(() => Array.from(new Set((faculty ?? []).map((f) => f.department).filter(Boolean))).sort(), [faculty]);
  const facultyReach = !withFaculty || !faculty ? 0 : facultyMode === 'all' ? faculty.length : facultyMode === 'department' ? faculty.filter((f) => f.department === dept).length : picked.size;
  const shownFaculty = (faculty ?? []).filter((f) => !facultySearch || `${f.name} ${f.department} ${f.designation}`.toLowerCase().includes(facultySearch.toLowerCase()));

  const audienceLabel = () => {
    const parts: string[] = [];
    if (withStudents) {
      if (studentMode === 'specific') parts.push(`${regNos.length} selected student${regNos.length === 1 ? '' : 's'}`);
      else {
        const b = batches.find((x) => x.key === batch);
        parts.push(['students', b ? `of ${yearLabel(b.year, b.pg)}` : 'of all years', branch || '', section && section !== branch ? section : ''].filter(Boolean).join(' '));
      }
    }
    if (withFaculty) {
      parts.push(facultyMode === 'all' ? 'all faculty' : facultyMode === 'department' ? `${dept} faculty` : `${picked.size} faculty member${picked.size === 1 ? '' : 's'}`);
    }
    return parts.join(' and ');
  };

  const reset = () => {
    setTitle('');
    setAgenda('');
    setRegText('');
    setPicked(new Set());
    setDate('');
    setEnd('');
  };

  const submit = async () => {
    setErr('');
    setOk('');
    if (!title.trim()) return setErr('Give the meeting a title.');
    if (!withStudents && !withFaculty) return setErr('Choose who should attend: students, faculty or both.');
    if (withStudents && studentMode === 'specific' && regNos.length === 0) return setErr('Type the enrollment numbers of the students to call.');
    if (withStudents && studentMode === 'specific' && unknownRegs.length) return setErr(`Not in the roster: ${unknownRegs.slice(0, 5).join(', ')}. Fix or remove them.`);
    if (withFaculty && facultyMode === 'department' && !dept) return setErr('Choose a department.');
    if (withFaculty && facultyMode === 'specific' && picked.size === 0) return setErr('Tick the faculty members to call.');
    if (!date) return setErr('Choose a date.');
    if (date < todayIso()) return setErr('The date has already passed.');
    if (end && end <= start) return setErr('End time must be after the start time.');
    if (!venue.trim()) return setErr('Choose where the meeting is.');
    if (studentReach + facultyReach === 0) return setErr('Nobody matches this choice.');
    const b = batches.find((x) => x.key === batch);
    setBusy(true);
    try {
      await addDoc(collection(db, 'meetings'), {
        title: title.trim(),
        agenda: agenda.trim(),
        date,
        startTime: start,
        endTime: end || null,
        venue: venue.trim(),
        status: 'scheduled',
        audience: {
          students: withStudents
            ? studentMode === 'specific'
              ? { admissionYears: [], branches: [], sections: [], regNos }
              : { admissionYears: b ? [b.year] : [], branches: branch ? [branch] : [], sections: section ? [section] : [], regNos: [] }
            : null,
          faculty: withFaculty
            ? {
                departments: facultyMode === 'department' ? [dept] : [],
                emails: facultyMode === 'specific' ? (faculty ?? []).filter((f) => picked.has(f.uid)).map((f) => f.email) : [],
              }
            : null,
        },
        audienceLabel: audienceLabel(),
        createdBy: auth.currentUser?.uid,
        createdByName: myName || auth.currentUser?.displayName || "Director's office",
        createdAt: serverTimestamp(),
      });
      setOk(`Sent. About ${studentReach + facultyReach} people will get a notification now. Those who have signed in to CollegeGo also see it in the app.`);
      reset();
    } catch (e: any) {
      setErr(`Couldn't send: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const today = todayIso();
  const upcoming = (list ?? []).filter((m) => m.date >= today).sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));
  const past = (list ?? []).filter((m) => m.date < today);
  const shown = tab === 'upcoming' ? upcoming : past;

  return (
    <div className="mt-page">
      <section className="card mt-form">
        <h1>Call a meeting</h1>
        <p className="mt-lead">Everyone you choose gets a notification on their phone and a card in the app with a "Got it" button, so you can see who has seen it.</p>

        <label htmlFor="mt-title">Title</label>
        <input id="mt-title" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Meeting with class representatives" />

        <div className="mt-who">
          <span className="mt-who-label">Who should attend?</span>
          <label className={`mt-check${withStudents ? ' on' : ''}`}>
            <input type="checkbox" checked={withStudents} onChange={(e) => setWithStudents(e.target.checked)} /> Students
          </label>
          <label className={`mt-check${withFaculty ? ' on' : ''}`}>
            <input type="checkbox" checked={withFaculty} onChange={(e) => setWithFaculty(e.target.checked)} /> Faculty
          </label>
        </div>

        {withStudents && (
          <div className="mt-box">
            <div className="mt-box-head">Students</div>
            <label>Choose by</label>
            <select value={studentMode} onChange={(e) => setStudentMode(e.target.value as 'group' | 'specific')}>
              <option value="group">Year, branch or section</option>
              <option value="specific">Specific students (enrollment numbers)</option>
            </select>
            {studentMode === 'group' ? (
              <div className="mt-grid3">
                <div>
                  <label>Year</label>
                  <select value={batch} onChange={(e) => { setBatch(e.target.value); setBranch(''); setSection(''); }}>
                    <option value="">All years</option>
                    {batches.map((b) => <option key={b.key} value={b.key}>{yearLabel(b.year, b.pg)}</option>)}
                  </select>
                </div>
                <div>
                  <label>Branch</label>
                  <select value={branch} onChange={(e) => { setBranch(e.target.value); setSection(''); }}>
                    <option value="">All branches</option>
                    {branches.map((b) => <option key={b} value={b}>{b}</option>)}
                  </select>
                </div>
                <div>
                  <label>Section</label>
                  <select value={section} onChange={(e) => setSection(e.target.value)} disabled={sections.length === 0}>
                    <option value="">All sections</option>
                    {sections.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
              </div>
            ) : (
              <>
                <label style={{ marginTop: 10 }}>Enrollment numbers</label>
                <textarea rows={3} value={regText} onChange={(e) => setRegText(e.target.value)} placeholder="UG23CSE001, UG23CSE045, UG24ECE012" />
                {unknownRegs.length > 0 && <p className="error-text">Not in the roster: {unknownRegs.join(', ')}</p>}
              </>
            )}
            <p className="mt-reach">{roster === null ? 'Loading roster…' : `${studentReach} student${studentReach === 1 ? '' : 's'} in the roster match`}</p>
          </div>
        )}

        {withFaculty && (
          <div className="mt-box">
            <div className="mt-box-head">Faculty</div>
            <label>Choose by</label>
            <select value={facultyMode} onChange={(e) => setFacultyMode(e.target.value as 'all' | 'department' | 'specific')}>
              <option value="all">All faculty</option>
              <option value="department">One department</option>
              <option value="specific">Specific people</option>
            </select>
            {facultyMode === 'department' && (
              <>
                <label style={{ marginTop: 10 }}>Department</label>
                <select value={dept} onChange={(e) => setDept(e.target.value)}>
                  <option value="" disabled>Choose a department</option>
                  {departments.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
              </>
            )}
            {facultyMode === 'specific' && (
              <>
                <input style={{ marginTop: 10 }} placeholder="Search by name or department" value={facultySearch} onChange={(e) => setFacultySearch(e.target.value)} />
                <div className="mt-people">
                  {shownFaculty.map((f) => (
                    <label key={f.uid} className={`mt-person${picked.has(f.uid) ? ' on' : ''}`}>
                      <input
                        type="checkbox"
                        checked={picked.has(f.uid)}
                        onChange={(e) => {
                          const next = new Set(picked);
                          if (e.target.checked) next.add(f.uid);
                          else next.delete(f.uid);
                          setPicked(next);
                        }}
                      />
                      <span>
                        <b>{f.name}</b>
                        <small>{[f.designation, f.department].filter(Boolean).join(' · ')}</small>
                      </span>
                    </label>
                  ))}
                </div>
              </>
            )}
            <p className="mt-reach">{faculty === null ? 'Loading faculty…' : `${facultyReach} faculty member${facultyReach === 1 ? '' : 's'}`}</p>
          </div>
        )}

        <div className="mt-grid3">
          <div>
            <label>Date</label>
            <input type="date" min={todayIso()} value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div>
            <label>Starts</label>
            <select value={start} onChange={(e) => { setStart(e.target.value); if (end && end <= e.target.value) setEnd(''); }}>
              {TIMES.map((t) => <option key={t} value={t}>{clock(t)}</option>)}
            </select>
          </div>
          <div>
            <label>Ends (optional)</label>
            <select value={end} onChange={(e) => setEnd(e.target.value)}>
              <option value="">Not set</option>
              {TIMES.filter((t) => t > start).map((t) => <option key={t} value={t}>{clock(t)}</option>)}
            </select>
          </div>
        </div>

        <label style={{ marginTop: 12 }}>Place</label>
        <VenuePicker value={venue} onChange={setVenue} />

        <label style={{ marginTop: 12 }}>Agenda (optional)</label>
        <textarea rows={3} maxLength={2000} value={agenda} onChange={(e) => setAgenda(e.target.value)} placeholder="What the meeting is about, what to bring" />

        {err && <p className="error-text" style={{ marginTop: 10 }}>{err}</p>}
        {ok && <p className="mt-ok">{ok}</p>}
        <button type="button" className="mt-send" onClick={submit} disabled={busy}>
          {busy ? 'Sending…' : `Send meeting notice${studentReach + facultyReach ? ` to ${studentReach + facultyReach}` : ''}`}
        </button>
      </section>

      <section className="card mt-list">
        <div className="mt-list-head">
          <h2>Meetings</h2>
          <div className="mt-tabs">
            <button type="button" className={tab === 'upcoming' ? 'on' : ''} onClick={() => setTab('upcoming')}>Upcoming · {upcoming.length}</button>
            <button type="button" className={tab === 'past' ? 'on' : ''} onClick={() => setTab('past')}>Past</button>
          </div>
        </div>
        {list === null ? (
          <p className="mt-empty">Loading…</p>
        ) : shown.length === 0 ? (
          <p className="mt-empty">{tab === 'upcoming' ? 'No meetings coming up. Meetings you call appear here with who has confirmed.' : 'No past meetings.'}</p>
        ) : (
          shown.map((m) => <MeetingRow key={m.id} m={m} mine={m.createdBy === auth.currentUser?.uid} />)
        )}
      </section>
    </div>
  );
}
