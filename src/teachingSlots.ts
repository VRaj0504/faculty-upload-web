import { getDocsCached } from './cachedCollection';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from './firebaseConfig';
import { FACULTY_LEGEND } from './facultyLegend';

export function facultyPartsOf(faculty: string): string[] {
  return String(faculty ?? '')
    .split(/[/,&;]+/)
    .map((part) => part.trim().toUpperCase())
    .filter(Boolean);
}

const looseKey = (s: string) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const EXACT_KEYS = new Set(Object.keys(FACULTY_LEGEND).map((k) => k.trim().toUpperCase()));

export function sameInitials(part: string, mine: string): boolean {
  const a = part.trim().toUpperCase();
  const b = mine.trim().toUpperCase();
  if (a === b) return true;
  if (looseKey(a) !== looseKey(b)) return false;

  return !EXACT_KEYS.has(a) || !EXACT_KEYS.has(b);
}

export function legendName(code: string): string | undefined {
  const t = code.trim().toUpperCase();
  const exact = Object.entries(FACULTY_LEGEND).find(([k]) => k.trim().toUpperCase() === t);
  if (exact) return exact[1].trim();
  const loose = Object.entries(FACULTY_LEGEND).find(([k]) => looseKey(k) === looseKey(code));
  return loose?.[1].trim();
}

export function teaches(slotFaculty: string, initials: string): boolean {
  return facultyPartsOf(slotFaculty).some((p) => sameInitials(p, initials));
}

const nameTokens = (n: string) =>
  String(n ?? '')
    .toLowerCase()
    .replace(/\b(dr|prof|mr|mrs|ms|shri|smt)\b\.?/g, ' ')
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);

export function initialsForName(name: string): string | null {
  const mine = nameTokens(name);
  if (mine.length < 2) return null;
  const hits = Object.entries(FACULTY_LEGEND).filter(([, full]) => {
    const theirs = nameTokens(full);
    const common = theirs.filter((t) => mine.includes(t)).length;
    return common >= 2 || (common >= 1 && theirs.length === 1);
  });
  return hits.length === 1 ? hits[0][0] : null;
}


export type MyClassSlot = {
  day: string;
  startTime: string;
  endTime: string;
  subjectCode: string;
  subjectName: string;
  room: string;
  branch: string;
  semester: number;
  section: string;
};

export function slotMinutes(time: string): number {
  const m = String(time ?? '').trim().match(/^(\d{1,2}):(\d{2})$/);
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : -1;
}

let mineCache: { key: string; p: Promise<MyClassSlot[]> } | null = null;

export function loadMyClassSlots(name: string): Promise<MyClassSlot[]> {
  const uid = auth.currentUser?.uid ?? '';
  const key = uid || name;
  if (mineCache && mineCache.key === key) return mineCache.p;
  const p = (async () => {
    let initials: string | null = null;
    let who = name;
    try {
      if (uid) {
        const snap = await getDoc(doc(db, 'users', uid));
        if (!who) who = String(snap.data()?.name ?? '');
        const explicit = String(snap.data()?.facultyInitials ?? '').trim().toUpperCase();
        if (explicit) initials = explicit;
        if (!initials) {
          const sf = String(snap.data()?.shortForm ?? '').trim().toUpperCase();
          if (sf) initials = sf;
        }
      }
    } catch {
      initials = null;
    }
    if (!initials) initials = initialsForName(who);
    if (!initials) return [];
    const snap = await getDocsCached('timetable');
    const out: MyClassSlot[] = [];
    snap.forEach((d) => {
      const tt = d.data() as { branch: string; semester: number; section: string; days?: { day: string; slots?: Omit<MyClassSlot, 'day' | 'branch' | 'semester' | 'section'>[] & { faculty: string }[] }[] };
      for (const day of tt.days ?? []) {
        for (const slot of (day.slots ?? []) as (MyClassSlot & { faculty: string })[]) {
          if (!teaches(slot.faculty, initials!)) continue;
          out.push({
            day: day.day,
            startTime: slot.startTime,
            endTime: slot.endTime,
            subjectCode: slot.subjectCode,
            subjectName: slot.subjectName,
            room: slot.room,
            branch: tt.branch,
            semester: Number(tt.semester),
            section: tt.section,
          });
        }
      }
    });
    return out.sort((a, b) => slotMinutes(a.startTime) - slotMinutes(b.startTime));
  })();
  p.catch(() => (mineCache = null));
  mineCache = { key, p };
  return p;
}

export function todaysClasses(all: MyClassSlot[], now = new Date()): MyClassSlot[] {
  const day = now.toLocaleDateString('en-US', { weekday: 'long' });
  const seen = new Set<string>();
  return all
    .filter((s) => s.day === day && slotMinutes(s.startTime) >= 0)
    .filter((s) => {
      const k = `${s.startTime}|${s.branch}|${s.semester}|${s.section}|${s.subjectCode}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}

export function formatClock(time: string): string {
  const mins = slotMinutes(time);
  if (mins < 0) return time;
  const h = Math.floor(mins / 60);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(mins % 60).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}
