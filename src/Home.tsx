import { Icon, type IconName } from './icons';
import { useEffect, useState } from 'react';
import { navFor, toneVars, type Tab, type Tone } from './nav';
import { loadMyClassSlots, todaysClasses, slotMinutes, formatClock, type MyClassSlot } from './teachingSlots';
import { collection, doc, getDoc, onSnapshot, query, serverTimestamp, setDoc, updateDoc, where, type Timestamp } from 'firebase/firestore';
import { auth, db } from './firebaseConfig';

function CabinToggle() {
  const uid = auth.currentUser?.uid;
  const [state, setState] = useState<{ on: boolean; at: Date | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!uid) return;
    return onSnapshot(
      doc(db, 'users', uid),
      (snap) => {
        const d = snap.data() as { inCabin?: boolean; inCabinAt?: Timestamp | null } | undefined;
        const at = d?.inCabinAt?.toDate?.() ?? null;
        const fresh = !at || at.toDateString() === new Date().toDateString();
        setState({ on: !!d?.inCabin && fresh, at });
      },
      () => setState({ on: false, at: null }),
    );
  }, [uid]);
  if (!uid || !state) return null;
  const toggle = async () => {
    setBusy(true);
    setErr('');
    try {
      await updateDoc(doc(db, 'users', uid), { inCabin: !state.on, inCabinAt: serverTimestamp() });
    } catch (e: any) {
      setErr(`Couldn't update: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };
  const since = state.at ? state.at.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }) : '';
  return (
    <div className="cabin-wrap">
      <button type="button" className={`cabin-btn ${state.on ? 'on' : ''}`} onClick={toggle} disabled={busy} aria-pressed={state.on}>
        <span className="cabin-dot" />
        {state.on ? `In cabin${since ? ` since ${since}` : ''}` : 'Mark me in cabin'}
        <span className="cabin-act">{state.on ? 'Leave' : ''}</span>
      </button>
      <span className="cabin-hint">{err || (state.on ? 'Students see you as available in the faculty directory. Clears at midnight.' : 'Lets students know you are in your cabin right now.')}</span>
    </div>
  );
}

type MyMeeting = { id: string; title: string; agenda?: string; date: string; startTime: string; endTime?: string | null; venue: string; status: string; createdByName?: string };

const hhmm = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
};

function MyMeetings({ name }: { name: string }) {
  const uid = auth.currentUser?.uid;
  const [items, setItems] = useState<MyMeeting[]>([]);
  const [acked, setAcked] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (!uid) return;
    return onSnapshot(
      query(collection(db, 'meetings'), where('recipientUids', 'array-contains', uid)),
      (s) => {
        const d = new Date();
        const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const list = s.docs
          .map((x) => ({ id: x.id, ...(x.data() as Omit<MyMeeting, 'id'>) }))
          .filter((m) => m.date >= today)
          .sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));
        setItems(list);
        list.forEach((m) =>
          getDoc(doc(db, 'meetings', m.id, 'acks', uid))
            .then((a) => setAcked((p) => ({ ...p, [m.id]: a.exists() })))
            .catch(() => undefined),
        );
      },
      () => setItems([]),
    );
  }, [uid]);
  if (!uid || items.length === 0) return null;
  const ack = async (id: string) => {
    setAcked((p) => ({ ...p, [id]: true }));
    await setDoc(doc(db, 'meetings', id, 'acks', uid), { name, role: 'faculty', at: serverTimestamp() }).catch(() => setAcked((p) => ({ ...p, [id]: false })));
  };
  return (
    <section className="my-meetings" aria-label="Meetings you are called to">
      {items.map((m) => (
        <div key={m.id} className={`my-meeting${m.status === 'cancelled' ? ' is-cancelled' : ''}`}>
          <span className="my-meeting-icon"><Icon name="users" size={18} /></span>
          <div className="my-meeting-body">
            <span className="my-meeting-kicker">{m.status === 'cancelled' ? 'Meeting cancelled' : `Meeting called by ${m.createdByName || "the Director's office"}`}</span>
            <b>{m.title}</b>
            <span>
              {new Date(`${m.date}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}, {hhmm(m.startTime)}
              {m.endTime ? ` – ${hhmm(m.endTime)}` : ''} · {m.venue}
            </span>
            {m.agenda && <small>{m.agenda}</small>}
          </div>
          {m.status !== 'cancelled' && (
            <button type="button" className={`my-meeting-ack${acked[m.id] ? ' done' : ''}`} onClick={() => ack(m.id)} disabled={!!acked[m.id]}>
              {acked[m.id] ? 'Confirmed' : 'Got it'}
            </button>
          )}
        </div>
      ))}
    </section>
  );
}

function greeting(d: Date) {
  const h = d.getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

function firstName(name: string) {
  const cleaned = name.replace(/^(dr|prof|mr|ms|mrs)\.?\s+/i, '').trim();
  if (cleaned.includes('@')) return '';
  const first = cleaned.split(/\s+/)[0] ?? '';
  return first ? first[0]!.toUpperCase() + first.slice(1) : '';
}

const LOGOS = [
  { x: '4%', y: '8%', s: 54, d: 15, delay: 0 },
  { x: '22%', y: '58%', s: 38, d: 19, delay: -6 },
  { x: '47%', y: '6%', s: 44, d: 17, delay: -3 },
  { x: '66%', y: '52%', s: 62, d: 21, delay: -9 },
  { x: '83%', y: '10%', s: 40, d: 16, delay: -12 },
  { x: '92%', y: '60%', s: 34, d: 18, delay: -5 },
];

type TileDef = {
  tab: Tab;
  title: string;
  sub: string;
  icon: IconName;
  tone: Tone | 'ink';
  big?: boolean;
  count?: number | null;
};

export default function Home({
  name,
  medicalWaiting,
  onOpen,
  isLeader = false,
}: {
  name: string;
  medicalWaiting: number | null;
  onOpen: (tab: Tab) => void;
  isLeader?: boolean;
}) {
  const NAV = navFor(isLeader);
  const now = new Date();
  const first = firstName(name);
  const [today, setToday] = useState<MyClassSlot[] | null>(null);
  useEffect(() => {
    let live = true;
    loadMyClassSlots(name)
      .then((all) => live && setToday(todaysClasses(all)))
      .catch(() => live && setToday([]));
    return () => {
      live = false;
    };
  }, [name]);
  const nowM = now.getHours() * 60 + now.getMinutes();
  const current = today?.find((x) => slotMinutes(x.startTime) <= nowM && nowM < slotMinutes(x.endTime)) ?? null;
  const next = today?.find((x) => slotMinutes(x.startTime) > nowM) ?? null;
  const justDone = !current ? today?.filter((x) => slotMinutes(x.endTime) <= nowM && nowM - slotMinutes(x.endTime) < 90).pop() ?? null : null;
  const focus = current ?? justDone ?? next;
  const where = (x: MyClassSlot) => [x.branch, `Sem ${x.semester}`, x.section && x.section !== x.branch ? x.section : null, x.room].filter(Boolean).join(' · ');

  const leaderTiles: TileDef[] = isLeader
    ? [
        { tab: 'directorOverview', title: 'Complaints and SOS', sub: 'How complaints are progressing and any active SOS', icon: 'chart', tone: 'ink', big: true },
        { tab: 'meetings', title: 'Call a meeting', sub: 'Students, faculty or both', icon: 'users', tone: 'blue' },
      ]
    : [];
  const baseTiles: TileDef[] = [
    { tab: 'resources', title: 'File a resource', sub: 'Notes, question papers and slides for your classes', icon: 'upload', tone: 'blue', big: true },
    {
      tab: 'medicalLeaves',
      title: 'Medical leaves',
      sub:
        medicalWaiting === null
          ? 'Office → Medical Officer → HOD, Dean, JR'
          : medicalWaiting === 0
            ? 'Nothing waiting on you'
            : `${medicalWaiting} waiting on you`,
      icon: 'medical',
      tone: 'lilac',
      count: medicalWaiting,
    },
    { tab: 'attendance', title: 'Attendance', sub: 'Mark a class or upload a register', icon: 'check', tone: 'mint' },
    { tab: 'announcements', title: 'Announce', sub: 'Notify a class on the app', icon: 'megaphone', tone: 'peach' },
    { tab: 'myTimetable', title: 'My timetable', sub: 'Where you teach this week', icon: 'clock', tone: 'ink' },
  ];
  const tiles: TileDef[] = isLeader
    ? [...leaderTiles, ...baseTiles.filter((t) => ['medicalLeaves', 'announcements', 'myTimetable'].includes(t.tab)).map((t) => (t.tab === 'myTimetable' ? { ...t, tone: 'mint' as const } : t))]
    : baseTiles;

  return (
    <div className="panel-enter home-wrap">
      <div className="home-bg" aria-hidden="true">
        <span className="home-blob hb1" />
        <span className="home-blob hb2" />
        <span className="home-blob hb3" />
        {LOGOS.map((l, i) => (
          <span
            key={i}
            className="home-logo"
            style={{ left: l.x, top: l.y, width: l.s, height: l.s, fontSize: l.s * 0.38, animationDuration: `${l.d}s`, animationDelay: `${l.delay}s` }}
          >
            IS
          </span>
        ))}
      </div>
      <div className="home-head">
        <div>
          <h1 className="home-hello">
            {greeting(now)}
            {first ? `, ${first}` : ''}
          </h1>
          <p className="home-date">
            {now.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}
          </p>
        </div>
        <CabinToggle />
      </div>

      <MyMeetings name={name} />

      {today && today.length > 0 && (
        <section className="today-card" aria-label="Your classes today">
          <div className="today-focus">
            <span className="today-kicker">{current ? 'Teaching now' : justDone ? 'Just finished' : focus ? 'Up next' : 'Done for today'}</span>
            {focus ? (
              <>
                <h2 className="today-title">{focus.subjectName || focus.subjectCode}</h2>
                <p className="today-sub">
                  {where(focus)} · {formatClock(focus.startTime)} – {formatClock(focus.endTime)}
                </p>
                {(current || justDone) && (
                  <button type="button" className="today-cta" onClick={() => onOpen('attendance')}>
                    Mark attendance for this class
                  </button>
                )}
              </>
            ) : (
              <h2 className="today-title">No more classes today</h2>
            )}
          </div>
          <ol className="today-list">
            {today.map((x, i) => {
              const a = slotMinutes(x.startTime);
              const b = slotMinutes(x.endTime);
              const state = b <= nowM ? 'done' : a <= nowM ? 'now' : 'later';
              return (
                <li key={`${x.startTime}-${x.subjectCode}-${x.section}-${i}`} className={`today-item is-${state}`}>
                  <span className="today-time">{formatClock(x.startTime)}</span>
                  <span className="today-what">
                    <strong>{x.subjectName || x.subjectCode}</strong>
                    <span>{where(x)}</span>
                  </span>
                  <span className="today-state">{state === 'now' ? 'Now' : state === 'done' ? 'Done' : ''}</span>
                </li>
              );
            })}
          </ol>
        </section>
      )}

      <div className="bento">
        {tiles.map((t) => (
          <button
            key={t.tab}
            type="button"
            className={`tile${t.big ? ' tile-big' : ''}${t.tone === 'ink' ? ' tile-ink' : ''}`}
            style={t.tone === 'ink' ? undefined : toneVars(t.tone)}
            onClick={() => onOpen(t.tab)}
          >
            <span className="tile-icon">
              <Icon name={t.icon} size={t.big ? 26 : 21} />
            </span>
            {t.count ? (
              <span className="tile-count" aria-label={`${t.count} waiting`}>{t.count}</span>
            ) : (
              <span className="tile-arrow" aria-hidden="true">
                <Icon name="arrow" size={16} />
              </span>
            )}
            <span>
              <p className="tile-title">{t.title}</p>
              <p className="tile-sub">{t.sub}</p>
            </span>
          </button>
        ))}
      </div>

      <div className="section-title">
        <h2>All tools</h2>
        <span>{NAV.reduce((n, g) => n + g.items.length, 0)} tools in {NAV.length} groups</span>
      </div>
      <div className="groups">
        {NAV.map((g) => (
          <section className="group-card" key={g.id} onMouseEnter={g.prefetch}>
            <div className="group-card-head">
              <span className="group-card-icon" style={toneVars(g.tone)}>
                <Icon name={g.icon} size={18} />
              </span>
              <div>
                <div className="group-card-title">{g.label}</div>
                <div className="group-card-sub">{g.hint}</div>
              </div>
            </div>
            <div className="group-links">
              {g.items.map((i) => (
                <button key={i.tab} type="button" className="group-link" onClick={() => onOpen(i.tab)}>
                  <span>{i.label}</span>
                  <Icon name="chevron" size={16} />
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
