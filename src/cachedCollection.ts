import { collection, getDocs } from 'firebase/firestore';
import { db } from './firebaseConfig';

export type CachedName = 'roster' | 'curriculum' | 'timetable';
type Row = { id: string; data: Record<string, unknown> };
export type CachedDoc = { id: string; data: () => any };
export type CachedSnap = { docs: CachedDoc[]; size: number; empty: boolean; forEach: (fn: (d: CachedDoc) => void) => void };

const FRESH_MS = 10 * 60 * 1000;
const KEY = (name: string) => `cg-portal-cache:v1:${name}`;
const memory = new Map<string, { at: number; rows: Row[] }>();
const inflight = new Map<string, Promise<Row[]>>();

function toSnap(rows: Row[]): CachedSnap {
  const docs = rows.map((r) => ({ id: r.id, data: () => r.data }));
  return { docs, size: docs.length, empty: docs.length === 0, forEach: (fn) => docs.forEach(fn) };
}

function readStored(name: string): { at: number; rows: Row[] } | null {
  try {
    const raw = localStorage.getItem(KEY(name));
    return raw ? (JSON.parse(raw) as { at: number; rows: Row[] }) : null;
  } catch {
    return null;
  }
}

function fetchFresh(name: string): Promise<Row[]> {
  const running = inflight.get(name);
  if (running) return running;
  const p = getDocs(collection(db, name))
    .then((snap) => {
      const rows = snap.docs.map((d) => ({ id: d.id, data: d.data() as Record<string, unknown> }));
      const entry = { at: Date.now(), rows };
      memory.set(name, entry);
      try {
        localStorage.setItem(KEY(name), JSON.stringify(entry));
      } catch {
        try {
          localStorage.removeItem(KEY(name));
        } catch {
          return rows;
        }
      }
      return rows;
    })
    .finally(() => inflight.delete(name));
  inflight.set(name, p);
  return p;
}

export async function getDocsCached(name: CachedName): Promise<CachedSnap> {
  const hit = memory.get(name) ?? readStored(name);
  if (hit) {
    memory.set(name, hit);
    if (Date.now() - hit.at > FRESH_MS) fetchFresh(name).catch(() => undefined);
    return toSnap(hit.rows);
  }
  return toSnap(await fetchFresh(name));
}

export function clearCached(name: CachedName) {
  memory.delete(name);
  try {
    localStorage.removeItem(KEY(name));
  } catch {
    return;
  }
}

export function warmCaches() {
  getDocsCached('roster').catch(() => undefined);
  getDocsCached('curriculum').catch(() => undefined);
}
