import { useEffect, useMemo, useState } from 'react';
import { collection, deleteDoc, doc, getDoc, getDocs } from 'firebase/firestore';
import { auth, db } from './firebaseConfig';
import { FACULTY_LEGEND } from './facultyLegend';

// A faculty member's timetable is NOT separate data that anyone has to
// enter — it's already implied by every section's published timetable,
// since each slot records who teaches it. This screen inverts that: scan
// every timetable, keep the slots whose faculty field mentions the
// selected person, and lay them out as that person's own week.
//
// Deriving it this way rather than adding a "faculty timetable" upload
// means it can never drift out of sync with what students see, and it
// costs the timetable committee no extra work at all. Change a class in
// the section's timetable and the teacher's week updates with it.

type Slot = {
  startTime: string;
  endTime: string;
  subjectCode: string;
  subjectName: string;
  faculty: string;
  room: string;
  group?: string;
};
type Day = { day: string; slots: Slot[] };
type TimetableDoc = { id: string; branch: string; semester: number; section: string; days: Day[] };

type TeachingSlot = Slot & { branch: string; semester: number; section: string; sectionKey: string; day: string };

// The same section is sometimes saved under two names — "A" from one
// import, "ECE A" from another (or "CSE2" vs "CSE 2"). Comparing this key
// instead of the raw text treats those as one section, so the same class
// isn't listed twice or reported as a clash with itself.
function sectionKey(branch: string, section: string): string {
  const b = String(branch ?? '').toUpperCase().replace(/[\s_-]+/g, '');
  let s = String(section ?? '').toUpperCase().replace(/[\s_-]+/g, '');
  s = s.replace(/^(SECTION|SEC)/, '');
  if (b && s.startsWith(b)) s = s.slice(b.length);
  return s; // '' = the branch's only section
}

// Two saved copies of one branch+semester+section.
type Duplicate = { label: string; copies: TimetableDoc[]; keep: TimetableDoc | null };

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

// Times are stored "H:MM" with the hour un-padded ("9:00"), so sorting
// them as text puts 9:00 after 10:00. Everything here compares minutes.
function toMinutes(time: string): number {
  const match = String(time ?? '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return -1;
  return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
}

function formatTime(time: string): string {
  const mins = toMinutes(time);
  if (mins < 0) return time;
  const h24 = Math.floor(mins / 60);
  const m = mins % 60;
  const period = h24 >= 12 ? 'PM' : 'AM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

// A slot's faculty field holds initials, and often SEVERAL people for
// one class ("ND / BP", "DR/NB/PG25CS04"). Splitting on the separators
// and matching each part exactly avoids the trap of a substring test,
// where searching "AP" would wrongly match "APS", "VAP" and "PAS F1"
// and hand a teacher three colleagues' classes.
function facultyPartsOf(faculty: string): string[] {
  return String(faculty ?? '')
    .split(/[/,&;]+/)
    .map((part) => part.trim().toUpperCase())
    .filter(Boolean);
}

// The legend is typed with dots/spaces ("R.N", "N B") but timetables store
// bare initials ("RN", "NB"), so an exact compare missed most teachers.
// Same rule as the app: exact first (keeps "RK" = Rahul Patel apart from
// "R.K." = Ritesh Kumar), then with dots/spaces/hyphens stripped.
const looseKey = (s: string) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const EXACT_KEYS = new Set(Object.keys(FACULTY_LEGEND).map((k) => k.trim().toUpperCase()));

function sameInitials(part: string, mine: string): boolean {
  const a = part.trim().toUpperCase();
  const b = mine.trim().toUpperCase();
  if (a === b) return true;
  if (looseKey(a) !== looseKey(b)) return false;
  // Spelled differently but the same letters: only a match if that spelling
  // isn't itself a different person's own legend key.
  return !EXACT_KEYS.has(a) || !EXACT_KEYS.has(b);
}

function legendName(code: string): string | undefined {
  const t = code.trim().toUpperCase();
  const exact = Object.entries(FACULTY_LEGEND).find(([k]) => k.trim().toUpperCase() === t);
  if (exact) return exact[1].trim();
  const loose = Object.entries(FACULTY_LEGEND).find(([k]) => looseKey(k) === looseKey(code));
  return loose?.[1].trim();
}

function teaches(slotFaculty: string, initials: string): boolean {
  return facultyPartsOf(slotFaculty).some((p) => sameInitials(p, initials));
}

// Which timetable initials belong to this login. An explicit
// `facultyInitials` on the user's profile wins; otherwise the profile name
// is matched to the legend ("Dr. Nishad Deshpande" -> ND). Only a single
// unambiguous match counts — guessing wrong would show someone else's week.
const nameTokens = (n: string) =>
  String(n ?? '')
    .toLowerCase()
    .replace(/\b(dr|prof|mr|mrs|ms|shri|smt)\b\.?/g, ' ')
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);

function initialsForName(name: string): string | null {
  const mine = nameTokens(name);
  if (mine.length < 2) return null;
  const hits = Object.entries(FACULTY_LEGEND).filter(([, full]) => {
    const theirs = nameTokens(full);
    const common = theirs.filter((t) => mine.includes(t)).length;
    return common >= 2 || (common >= 1 && theirs.length === 1);
  });
  return hits.length === 1 ? hits[0][0] : null;
}

function MyTimetable({ role, name }: { role: string | null; name: string }) {
  const isAdmin = role === 'admin';
  const [ownInitials, setOwnInitials] = useState<string | null | undefined>(undefined); // undefined = still working it out
  const [timetables, setTimetables] = useState<TimetableDoc[] | null>(null);
  const [initials, setInitials] = useState('');
  const [error, setError] = useState('');
  const [rosterSections, setRosterSections] = useState<Set<string> | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  // Work out who "me" is, then lock the screen to that person.
  useEffect(() => {
    let cancelled = false;
    const uid = auth.currentUser?.uid;
    (async () => {
      let found: string | null = null;
      try {
        if (uid) {
          const snap = await getDoc(doc(db, 'users', uid));
          const explicit = String(snap.data()?.facultyInitials ?? '').trim().toUpperCase();
          if (explicit) found = explicit;
        }
      } catch {
        /* fall back to the name match */
      }
      if (!found) found = initialsForName(name);
      if (!cancelled) {
        setOwnInitials(found);
        if (found) setInitials(found);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [name]);

  useEffect(() => {
    getDocs(collection(db, 'timetable'))
      .then((snap) => setTimetables(snap.docs.map((d) => ({ ...(d.data() as Omit<TimetableDoc, 'id'>), id: d.id }))))
      .catch((err) => setError(`Could not load timetables: ${err.message}`));
    // Which section names students actually have — tells us which of two
    // duplicate copies is the one the app shows them.
    getDocs(collection(db, 'roster'))
      .then((snap) => {
        const set = new Set<string>();
        snap.forEach((d) => {
          const r = d.data() as { branch?: string; section?: string };
          if (r.branch && r.section) set.add(`${r.branch}|${r.section}`);
        });
        setRosterSections(set);
      })
      .catch(() => setRosterSections(new Set()));
  }, []);

  const duplicates = useMemo<Duplicate[]>(() => {
    if (!timetables) return [];
    const groups = new Map<string, TimetableDoc[]>();
    for (const tt of timetables) {
      const key = `${tt.branch}|${tt.semester}|${sectionKey(tt.branch, tt.section)}`;
      groups.set(key, [...(groups.get(key) ?? []), tt]);
    }
    return Array.from(groups.values())
      .filter((copies) => copies.length > 1)
      .map((copies) => {
        const used = rosterSections ? copies.filter((c) => rosterSections.has(`${c.branch}|${c.section}`)) : [];
        const k = sectionKey(copies[0].branch, copies[0].section);
        return {
          label: `${copies[0].branch} Sem ${copies[0].semester}${k ? ` ${k}` : ''}`,
          copies,
          keep: used.length === 1 ? used[0] : null,
        };
      });
  }, [timetables, rosterSections]);

  async function deleteCopy(dup: Duplicate, copy: TimetableDoc) {
    const keepName = dup.keep ? `"${dup.keep.section}"` : 'the other copy';
    if (
      !confirm(
        `Delete the "${copy.section}" copy of ${dup.label}?\n\nStudents use ${keepName}, so they won't notice any change. This can't be undone.`,
      )
    )
      return;
    setDeleting(copy.id);
    setError('');
    try {
      await deleteDoc(doc(db, 'timetable', copy.id));
      setTimetables((tts) => (tts ?? []).filter((t) => t.id !== copy.id));
    } catch (err) {
      setError(`Could not delete: ${(err as Error).message}`);
    } finally {
      setDeleting(null);
    }
  }

  // Every set of initials that actually appears in a real published
  // timetable, so the picker offers who genuinely teaches rather than
  // the whole legend (which includes people with no classes this term).
  // Anyone teaching but missing from the legend still shows, by their
  // initials alone, rather than being silently unselectable.
  const teachingInitials = useMemo(() => {
    if (!timetables) return [];
    const seen = new Set<string>();
    for (const tt of timetables) {
      for (const day of tt.days ?? []) {
        for (const slot of day.slots ?? []) {
          for (const part of facultyPartsOf(slot.faculty)) seen.add(part);
        }
      }
    }
    return Array.from(seen).sort((a, b) => {
      const an = legendName(a) ?? '';
      const bn = legendName(b) ?? '';
      // Named faculty first (alphabetically), then bare codes — which are
      // mostly TA identifiers like PG25CS07 and less useful to browse.
      if (an && bn) return an.localeCompare(bn);
      if (an) return -1;
      if (bn) return 1;
      return a.localeCompare(b);
    });
  }, [timetables]);

  const byDay = useMemo(() => {
    const result: Record<string, TeachingSlot[]> = Object.fromEntries(WEEKDAYS.map((d) => [d, []]));
    if (!timetables || !initials) return result;
    // Prefer the copy students actually use when a section is saved twice,
    // so its name is the one shown.
    const preferred = new Set(duplicates.map((d) => d.keep?.id).filter(Boolean) as string[]);
    const ordered = [...timetables].sort((a, b) => Number(preferred.has(b.id)) - Number(preferred.has(a.id)));
    const seen = new Set<string>();
    for (const tt of ordered) {
      const sKey = sectionKey(tt.branch, tt.section);
      for (const day of tt.days ?? []) {
        if (!result[day.day]) continue;
        for (const slot of day.slots ?? []) {
          if (!teaches(slot.faculty, initials)) continue;
          const dupKey = [day.day, tt.branch, tt.semester, sKey, toMinutes(slot.startTime), toMinutes(slot.endTime),
            slot.subjectCode, slot.group ?? ''].join('|');
          if (seen.has(dupKey)) continue; // same class from a duplicate copy
          seen.add(dupKey);
          result[day.day].push({
            ...slot,
            branch: tt.branch,
            semester: tt.semester,
            section: tt.section,
            sectionKey: sKey,
            day: day.day,
          });
        }
      }
    }
    for (const day of WEEKDAYS) {
      result[day].sort((a, b) => toMinutes(a.startTime) - toMinutes(b.startTime));
    }
    return result;
  }, [timetables, initials, duplicates]);

  const totalClasses = WEEKDAYS.reduce((sum, d) => sum + byDay[d].length, 0);

  // Two sections scheduled on top of each other for the same teacher is
  // a real scheduling error worth surfacing loudly — it means whoever
  // built the timetable double-booked a person, and nobody would notice
  // until the teacher had to be in two rooms at once.
  const clashes = useMemo(() => {
    const found: { day: string; a: TeachingSlot; b: TeachingSlot }[] = [];
    for (const day of WEEKDAYS) {
      const slots = byDay[day];
      for (let i = 0; i < slots.length; i++) {
        for (let j = i + 1; j < slots.length; j++) {
          const a = slots[i];
          const b = slots[j];
          const overlap =
            toMinutes(a.startTime) < toMinutes(b.endTime) && toMinutes(b.startTime) < toMinutes(a.endTime);
          // Two groups of the SAME class at the same hour is normal (a
          // split lab the teacher runs together), not a clash.
          const sameClass =
            a.subjectCode === b.subjectCode && a.branch === b.branch && a.semester === b.semester && a.sectionKey === b.sectionKey;
          if (overlap && !sameClass) found.push({ day, a, b });
        }
      }
    }
    return found;
  }, [byDay]);

  return (
    <div className="card" style={{ width: 760, padding: '2.5rem', margin: '3rem auto' }}>
      <h1 style={{ fontSize: '1.5rem' }}>My Timetable</h1>
      <p style={{ fontSize: '0.85rem', color: 'var(--ink-soft)' }}>
        Built automatically from every section's published timetable — whoever is listed as faculty
        on a class has that class here. Nothing to upload: fix a class in the Timetable editor and
        this updates with it.
      </p>

      {error && <p style={{ color: '#b91c1c', fontSize: '0.85rem' }}>{error}</p>}

      {!isAdmin && ownInitials === null && (
        <div className="notice notice-error" style={{ marginTop: '1.5rem' }}>
          Couldn't match your login ({name}) to a name on the timetable. Ask the admin to add{' '}
          <code>facultyInitials</code> (your initials as written on the timetable) to your user profile.
        </div>
      )}

      {!isAdmin && ownInitials && (
        <p style={{ marginTop: '1.25rem', fontSize: '0.9rem' }}>
          Showing your classes only — <strong>{FACULTY_LEGEND[ownInitials] ?? ownInitials}</strong> ({ownInitials}).
        </p>
      )}

      {isAdmin && (
      <div style={{ marginTop: '1.5rem' }}>
        <label>Faculty{ownInitials ? ' (you are preselected)' : ''}</label>
        <select value={teachingInitials.find((c) => sameInitials(c, initials)) ?? initials} onChange={(e) => setInitials(e.target.value)} style={{ width: '100%' }}>
          <option value="">
            {timetables === null ? 'Loading timetables…' : 'Pick who to show…'}
          </option>
          {teachingInitials.map((code) => (
            <option key={code} value={code}>
              {legendName(code) ? `${legendName(code)} (${code})` : code}
            </option>
          ))}
        </select>
      </div>
      )}

      {initials && (
        <>
          <p style={{ marginTop: '1rem', fontSize: '0.9rem' }}>
            {totalClasses === 0
              ? 'No classes found for this person in any published timetable.'
              : `${totalClasses} class${totalClasses === 1 ? '' : 'es'} a week.`}
          </p>

          {duplicates.length > 0 && (
            <div
              style={{
                marginTop: '0.75rem',
                padding: '0.85rem 1rem',
                background: 'var(--tone-yellow-bg, #FFF1B8)',
                color: 'var(--tone-yellow-fg, #854D0E)',
                borderRadius: 12,
                fontSize: '0.85rem',
              }}
            >
              <strong>
                {duplicates.length === 1 ? '1 timetable is' : `${duplicates.length} timetables are`} saved twice
              </strong>
              <p style={{ margin: '0.25rem 0 0' }}>
                Same section under two names, so it's shown once here. Deleting the copy students don't use keeps
                things tidy.
              </p>
              <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.2rem' }}>
                {duplicates.map((d) => (
                  <li key={d.label} style={{ marginTop: '0.3rem' }}>
                    {d.label}: saved as {d.copies.map((c) => `"${c.section}"`).join(' and ')}.{' '}
                    {d.keep ? (
                      <>
                        Students use "{d.keep.section}".{' '}
                        {d.copies
                          .filter((c) => c.id !== d.keep!.id)
                          .map((c) => (
                            <button
                              key={c.id}
                              type="button"
                              className="button-secondary"
                              disabled={deleting === c.id}
                              onClick={() => deleteCopy(d, c)}
                              style={{ padding: '0.25rem 0.7rem', fontSize: '0.78rem', marginLeft: '0.25rem' }}
                            >
                              {deleting === c.id ? 'Deleting…' : `Delete "${c.section}" copy`}
                            </button>
                          ))}
                      </>
                    ) : rosterSections === null ? (
                      'Checking which one students use…'
                    ) : (
                      "Couldn't tell which one students use from the roster, so nothing is deleted."
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {clashes.length > 0 && (
            <div
              style={{
                marginTop: '0.75rem',
                padding: '0.75rem',
                border: '1px solid #fca5a5',
                background: '#fef2f2',
                borderRadius: 6,
                fontSize: '0.85rem',
              }}
            >
              <strong style={{ color: '#b91c1c' }}>
                ⚠ {clashes.length} scheduling clash{clashes.length === 1 ? '' : 'es'}
              </strong>
              <p style={{ margin: '0.25rem 0 0', color: 'var(--ink-soft)' }}>
                This person is timetabled for two different classes at the same time — worth fixing
                in the Timetable editor.
              </p>
              <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.2rem' }}>
                {clashes.map((c, i) => (
                  <li key={i}>
                    {c.day} {formatTime(c.a.startTime)} — {c.a.subjectCode} ({c.a.branch} Sem{' '}
                    {c.a.semester} {c.a.section}) vs {c.b.subjectCode} ({c.b.branch} Sem{' '}
                    {c.b.semester} {c.b.section})
                  </li>
                ))}
              </ul>
            </div>
          )}

          {WEEKDAYS.map((day) => (
            <div key={day} style={{ marginTop: '1.25rem' }}>
              <h3 style={{ fontSize: '1rem', marginBottom: '0.4rem' }}>{day}</h3>
              {byDay[day].length === 0 ? (
                <p style={{ fontSize: '0.8rem', color: 'var(--ink-soft)', margin: 0 }}>No classes.</p>
              ) : (
                byDay[day].map((slot, i) => (
                  <div
                    key={`${slot.branch}-${slot.semester}-${slot.section}-${slot.startTime}-${i}`}
                    style={{
                      display: 'flex',
                      gap: '0.75rem',
                      alignItems: 'baseline',
                      padding: '0.5rem 0.6rem',
                      border: '1px solid var(--line)',
                      borderRadius: 6,
                      marginBottom: '0.35rem',
                      fontSize: '0.85rem',
                    }}
                  >
                    <span style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
                      {formatTime(slot.startTime)}–{formatTime(slot.endTime)}
                    </span>
                    <span style={{ flex: 1 }}>
                      <strong>{slot.subjectCode}</strong>
                      {slot.subjectName ? ` · ${slot.subjectName}` : ''}
                      <br />
                      <span style={{ color: 'var(--ink-soft)' }}>
                        {slot.branch} Sem {slot.semester} {slot.section}
                        {slot.group ? ` · ${slot.group}` : ''}
                        {slot.room ? ` · ${slot.room}` : ''}
                        {facultyPartsOf(slot.faculty).length > 1
                          ? ` · with ${facultyPartsOf(slot.faculty)
                              .filter((p) => !sameInitials(p, initials))
                              .map((p) => legendName(p) ?? p)
                              .join(', ')}`
                          : ''}
                      </span>
                    </span>
                  </div>
                ))
              )}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

export default MyTimetable;
