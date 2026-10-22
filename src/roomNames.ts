import { doc, getDoc, setDoc, updateDoc, deleteField, FieldPath, serverTimestamp } from 'firebase/firestore';
import { db, auth } from './firebaseConfig';

export function splitRooms(raw: string): string[] {
  return String(raw ?? '')
    .split(/[/,&;]+|\s+and\s+/i)
    .map((r) => r.trim())
    .filter(Boolean);
}

export function roomKey(room: string): string {
  return String(room ?? '').toUpperCase().replace(/[\s\-_.]+/g, '');
}

export type RoomAliases = Record<string, string>;

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
    return {};
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

export function cleanDays<T extends { slots: { room: string }[] }>(days: T[], aliases: RoomAliases): T[] {
  if (!Object.keys(aliases).length) return days;
  return days.map((d) => ({ ...d, slots: d.slots.map((s) => ({ ...s, room: applyRoomAliases(s.room, aliases) })) }));
}
