import { doc, getDoc, setDoc, updateDoc, deleteField, FieldPath, serverTimestamp } from 'firebase/firestore';
import { db, auth } from './firebaseConfig';

// Room-name helpers shared by Room names (RoomCleanup.tsx) and the
// Timetable editor's save.
//
// Why fixes are REMEMBERED: renaming "CR 1 DN" to "CR 1" across today's
// timetables isn't enough — the next time someone imports the same PDF or
// Excel sheet, "CR 1 DN" comes straight back and the app shows the wrong
// room again. Every fix made in Room names is saved to roomAliases/main,
// and every timetable save applies those fixes before writing.

// One slot's room field can name several rooms ("CR 1 / CR 2",
// "LAB1, LAB2") — the same separators the app's Free rooms screen splits on.
export function splitRooms(raw: string): string[] {
  return String(raw ?? '')
    .split(/[/,&;]+|\s+and\s+/i)
    .map((r) => r.trim())
    .filter(Boolean);
}

// Same key the app uses: case, spaces, hyphens, dots and underscores
// don't make a different room ("CR-1" = "cr 1" = "CR1").
export function roomKey(room: string): string {
  return String(room ?? '').toUpperCase().replace(/[\s\-_.]+/g, '');
}

// key of a wrong name -> the right name ('' = not a room, remove it).
export type RoomAliases = Record<string, string>;

// Rewrites one slot's room field with the remembered fixes. Returns the
// field unchanged (same formatting) when nothing in it needs fixing.
export function applyRoomAliases(raw: string, aliases: RoomAliases): string {
  const parts = splitRooms(raw);
  if (!parts.length) return raw ?? '';
  let changed = false;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of parts) {
    const k = roomKey(p);
    let name = p;
    if (Object.prototype.hasOwnProperty.call(aliases, k)) {
      name = aliases[k];
      if (name !== p) changed = true;
    }
    const nk = roomKey(name);
    if (!nk) continue;
    if (seen.has(nk)) {
      changed = true;
      continue;
    }
    seen.add(nk);
    out.push(name);
  }
  return changed ? out.join(' / ') : raw;
}

const aliasDoc = () => doc(db, 'roomAliases', 'main');

export async function loadRoomAliases(): Promise<RoomAliases> {
  try {
    const snap = await getDoc(aliasDoc());
    return ((snap.data()?.map ?? {}) as RoomAliases) || {};
  } catch {
    return {}; // rules not deployed yet / offline — fixing still works, just isn't remembered
  }
}

export async function rememberRoomAliases(additions: RoomAliases): Promise<void> {
  await setDoc(
    aliasDoc(),
    { map: additions, updatedAt: serverTimestamp(), updatedBy: auth.currentUser?.email ?? '' },
    { merge: true },
  );
}

export async function forgetRoomAlias(key: string): Promise<void> {
  await updateDoc(aliasDoc(), new FieldPath('map', key), deleteField());
}

// Applies remembered fixes to a whole week before it's saved.
export function cleanDays<T extends { slots: { room: string }[] }>(days: T[], aliases: RoomAliases): T[] {
  if (!Object.keys(aliases).length) return days;
  return days.map((d) => ({ ...d, slots: d.slots.map((s) => ({ ...s, room: applyRoomAliases(s.room, aliases) })) }));
}
