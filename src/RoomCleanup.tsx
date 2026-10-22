import { useEffect, useMemo, useState } from 'react';
import { collection, getDocs, doc, writeBatch, serverTimestamp } from 'firebase/firestore';
import { db } from './firebaseConfig';
import { FACULTY_LEGEND } from './facultyLegend';
import {
  applyRoomAliases,
  forgetRoomAlias,
  loadRoomAliases,
  rememberRoomAliases,
  roomKey,
  splitRooms,
  type RoomAliases,
} from './roomNames';

type TimetableSlot = {
  id: string;
  startTime: string;
  endTime: string;
  subjectCode: string;
  subjectName: string;
  faculty: string;
  room: string;
  group?: string;
};
type TimetableDay = { day: string; slots: TimetableSlot[] };
type TimetableDoc = { branch: string; semester: number; section: string; days: TimetableDay[] };

type Use = { cls: string; day: string; time: string; subject: string; faculty: string };
type Room = {
  key: string;
  name: string;
  spellings: string[];
  count: number;
  uses: Use[];
};
type Suggestion = { from: Room; to: string; why: string };

const PLACEHOLDERS = new Set(['-', '--', 'NA', 'N/A', 'NIL', 'TBA', 'TBD', 'ROOM', '?', 'X', '0']);
const letters = (w: string) => w.toUpperCase().replace(/[^A-Z]/g, '');

const LEGEND_BY_LETTERS = new Map(Object.entries(FACULTY_LEGEND).map(([k, v]) => [letters(k), v]));
const isInitials = (w: string) => !/\d/.test(w) && LEGEND_BY_LETTERS.has(letters(w));

function collectRooms(docs: { id: string; data: TimetableDoc }[]): Room[] {
  const byKey = new Map<string, { spellings: Map<string, number>; uses: Use[] }>();
  for (const { data } of docs) {
    const cls = `${data.branch} Sem ${data.semester}${data.section && data.section !== data.branch ? ` ${data.section}` : ''}`;
    for (const day of data.days ?? []) {
      for (const slot of day.slots ?? []) {
        for (const name of splitRooms(slot.room)) {
          const key = roomKey(name);
          if (!key) continue;
          const entry = byKey.get(key) ?? { spellings: new Map<string, number>(), uses: [] as Use[] };
          entry.spellings.set(name, (entry.spellings.get(name) ?? 0) + 1);
          entry.uses.push({
            cls,
            day: day.day.slice(0, 3),
            time: slot.startTime,
            subject: slot.subjectCode || slot.subjectName,
            faculty: slot.faculty,
          });
          byKey.set(key, entry);
        }
      }
    }
  }
  return Array.from(byKey, ([key, e]) => {

    const tidy = (s: string) => (/[A-Za-z] \d/.test(s) ? 2 : 0) + (s === s.toUpperCase() || /^[A-Z][a-z]+ /.test(s) ? 1 : 0) - (/[-_.]/.test(s) ? 1 : 0);
    const spellings = Array.from(e.spellings)
      .sort((a, b) => tidy(b[0]) - tidy(a[0]) || b[1] - a[1])
      .map(([s]) => s);
    return { key, name: spellings[0], spellings, count: e.uses.length, uses: e.uses };
  }).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

function suggest(rooms: Room[]): Suggestion[] {
  const byKey = new Map(rooms.map((r) => [r.key, r]));
  const out: Suggestion[] = [];
  for (const r of rooms) {
    const upper = r.name.toUpperCase().trim();
    if (PLACEHOLDERS.has(upper)) {
      out.push({ from: r, to: '', why: 'Placeholder, not a room' });
      continue;
    }
    if (isInitials(upper)) {
      out.push({ from: r, to: '', why: `Teacher's initials (${LEGEND_BY_LETTERS.get(letters(upper))}), not a room` });
      continue;
    }

    const words = r.name.replace(/[()]/g, ' ').split(/\s+/).filter(Boolean);
    let a = 0;
    let b = words.length;
    while (a < b - 1 && isInitials(words[a])) a++;

    while (
      b > a + 1 &&
      (isInitials(words[b - 1]) || (/^[A-Z]{2,4}$/.test(words[b - 1]) && /\d$/.test(words[b - 2])))
    )
      b--;
    if (a > 0 || b < words.length) {
      const core = words.slice(a, b).join(' ');
      const existing = byKey.get(roomKey(core));
      const stripped = [...words.slice(0, a), ...words.slice(b)].join(', ');
      out.push({
        from: r,
        to: existing && existing.key !== r.key ? existing.name : core,
        why: `"${stripped}" is a teacher's initials`,
      });
      continue;
    }
    if (r.spellings.length > 1) {
      out.push({ from: r, to: r.name, why: `Same room typed ${r.spellings.length} ways: ${r.spellings.join(', ')}` });
    }
  }
  return out;
}

export default function RoomCleanup() {
  const [docs, setDocs] = useState<{ id: string; data: TimetableDoc }[] | null>(null);
  const [aliases, setAliases] = useState<RoomAliases>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rename, setRename] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: 'ok' | 'error' | 'info'; text: string } | null>(null);

  const load = async () => {
    const [snap, al] = await Promise.all([getDocs(collection(db, 'timetable')), loadRoomAliases()]);
    setDocs(snap.docs.map((d) => ({ id: d.id, data: d.data() as TimetableDoc })));
    setAliases(al);
  };
  useEffect(() => {
    load().catch((e) => setStatus({ kind: 'error', text: `Could not load timetables: ${e.message}` }));
  }, []);

  const rooms = useMemo(() => (docs ? collectRooms(docs) : []), [docs]);
  const suggestions = useMemo(() => suggest(rooms), [rooms]);
  const flagged = useMemo(() => new Map(suggestions.map((s) => [s.from.key, s])), [suggestions]);
  const cleanNames = useMemo(() => rooms.filter((r) => !flagged.has(r.key) || flagged.get(r.key)!.to === r.name).map((r) => r.name), [rooms, flagged]);
  const shown = useMemo(() => {
    const q = roomKey(search);
    return q ? rooms.filter((r) => r.key.includes(q) || r.uses.some((u) => roomKey(u.cls).includes(q))) : rooms;
  }, [rooms, search]);

  async function apply(fixes: RoomAliases, summary: string) {
    if (!docs) return;
    setBusy(true);
    setStatus(null);
    try {
      let slots = 0;
      const changedDocs: { id: string; days: TimetableDay[] }[] = [];
      for (const { id, data } of docs) {
        let changed = false;
        const days = (data.days ?? []).map((day) => ({
          ...day,
          slots: (day.slots ?? []).map((slot) => {
            const room = applyRoomAliases(slot.room, fixes);
            if (room !== slot.room) {
              changed = true;
              slots++;
              return { ...slot, room };
            }
            return slot;
          }),
        }));
        if (changed) changedDocs.push({ id, days });
      }

      for (let i = 0; i < changedDocs.length; i += 400) {
        const batch = writeBatch(db);
        for (const c of changedDocs.slice(i, i + 400)) batch.update(doc(db, 'timetable', c.id), { days: c.days, lastRoomCleanup: serverTimestamp() });
        await batch.commit();
      }
      let remembered = true;
      try {
        await rememberRoomAliases(fixes);
      } catch {
        remembered = false;
      }
      setSelected(new Set());
      setRename('');
      await load();
      setStatus({
        kind: remembered ? 'ok' : 'info',
        text:
          `${summary} — ${slots} class slot${slots === 1 ? '' : 's'} in ${changedDocs.length} timetable${changedDocs.length === 1 ? '' : 's'} updated.` +
          (remembered
            ? ' Remembered, so re-importing a timetable won\'t bring it back.'
            : ' (Couldn\'t remember it for future imports — deploy the updated firestore.rules.)'),
      });
    } catch (e) {
      setStatus({ kind: 'error', text: `Could not apply: ${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  }

  const fixOne = (s: Suggestion) => {
    const fixes: RoomAliases = {};
    for (const sp of s.from.spellings) fixes[roomKey(sp)] = s.to;
    const msg = s.to ? `Change "${s.from.spellings.join('", "')}" to "${s.to}" in ${s.from.count} class slot(s)?` : `Remove "${s.from.name}" from ${s.from.count} class slot(s)? Those classes will show no room.`;
    if (!confirm(msg)) return;
    apply(fixes, s.to ? `"${s.from.name}" → "${s.to}"` : `Removed "${s.from.name}"`);
  };

  const fixAll = () => {
    if (!confirm(`Apply all ${suggestions.length} suggested fixes?`)) return;
    const fixes: RoomAliases = {};
    for (const s of suggestions) for (const sp of s.from.spellings) fixes[roomKey(sp)] = s.to;
    apply(fixes, `Applied ${suggestions.length} fixes`);
  };

  const renameSelected = (to: string) => {
    const picked = rooms.filter((r) => selected.has(r.key));
    if (!picked.length) return;
    const names = picked.map((r) => `"${r.name}"`).join(', ');
    const n = picked.reduce((s, r) => s + r.count, 0);
    if (!confirm(to ? `Rename ${names} to "${to}" in ${n} class slot(s)?` : `Remove ${names} from ${n} class slot(s)? Those classes will show no room.`)) return;
    const fixes: RoomAliases = {};
    for (const r of picked) for (const sp of r.spellings) fixes[roomKey(sp)] = to;
    apply(fixes, to ? `Renamed ${names} → "${to}"` : `Removed ${names}`);
  };

  const toggle = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const rememberedList = Object.entries(aliases).sort((a, b) => a[0].localeCompare(b[0]));

  return (
    <div className="card rooms" style={{ width: 860, maxWidth: '100%', padding: '2rem 2.25rem', margin: '1.5rem auto' }}>
      <h1 style={{ fontSize: '1.5rem', margin: 0 }}>Room names</h1>
      <p className="rooms-lead">
        Every room used in any timetable — the same list students see in Free rooms. Fix a wrong one here and it's fixed
        everywhere, and remembered so the next timetable import can't bring it back.
      </p>

      {status && (
        <div
          className={`notice ${status.kind === 'error' ? 'notice-error' : status.kind === 'ok' ? 'notice-ok' : ''}`}
          style={status.kind === 'info' ? { background: 'var(--tone-yellow-bg)', color: 'var(--tone-yellow-fg)' } : undefined}
          role="status"
        >
          {status.text}
        </div>
      )}

      {docs === null && <p className="rooms-lead">Loading every timetable…</p>}

      {suggestions.length > 0 && (
        <section className="rooms-suggest">
          <div className="rooms-suggest-head">
            <div>
              <strong>{suggestions.length} name{suggestions.length === 1 ? '' : 's'} look wrong</strong>
              <span>Check each one — nothing changes until you click.</span>
            </div>
            {suggestions.length > 1 && (
              <button type="button" onClick={fixAll} disabled={busy}>
                Fix all {suggestions.length}
              </button>
            )}
          </div>
          {suggestions.map((s) => (
            <div key={s.from.key} className="rooms-suggest-row">
              <div style={{ minWidth: 0 }}>
                <div className="rooms-fix">
                  <span className="rooms-bad">{s.from.spellings.length > 1 ? s.from.spellings.join(' · ') : s.from.name}</span>
                  <span aria-hidden="true">→</span>
                  {s.to ? <span className="rooms-good">{s.to}</span> : <span className="rooms-none">no room</span>}
                </div>
                <div className="rooms-why">
                  {s.why} · {s.from.count} slot{s.from.count === 1 ? '' : 's'}, e.g. {s.from.uses[0].cls} {s.from.uses[0].day}{' '}
                  {s.from.uses[0].time} {s.from.uses[0].subject}
                </div>
              </div>
              <button type="button" className="button-secondary" disabled={busy} onClick={() => fixOne(s)}>
                {s.to ? 'Fix' : 'Remove'}
              </button>
            </div>
          ))}
        </section>
      )}

      {docs && (
        <>
          <div className="rooms-toolbar">
            <h2>All rooms <span>{rooms.length}</span></h2>
            <input placeholder="Search room or class…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>

          {selected.size > 0 && (
            <div className="rooms-action">
              <strong>
                {selected.size} selected: {rooms.filter((r) => selected.has(r.key)).map((r) => r.name).join(', ')}
              </strong>
              <div className="rooms-action-row">
                <input
                  list="room-names"
                  value={rename}
                  onChange={(e) => setRename(e.target.value)}
                  placeholder="Correct room name, e.g. CR 1"
                />
                <datalist id="room-names">
                  {cleanNames.map((n) => (
                    <option key={n} value={n} />
                  ))}
                </datalist>
                <button type="button" disabled={busy || !rename.trim()} onClick={() => renameSelected(rename.trim())}>
                  Rename
                </button>
                <button type="button" className="button-secondary" disabled={busy} onClick={() => renameSelected('')}>
                  Not a room — remove
                </button>
                <button type="button" className="button-secondary" onClick={() => setSelected(new Set())}>
                  Clear
                </button>
              </div>
            </div>
          )}

          <div className="rooms-list">
            {shown.map((r) => {
              const flag = flagged.get(r.key);
              const isOpen = open === r.key;
              return (
                <div key={r.key} className={`rooms-row${selected.has(r.key) ? ' rooms-row-on' : ''}`}>
                  <div className="rooms-row-main">
                    <input type="checkbox" aria-label={`Select ${r.name}`} checked={selected.has(r.key)} onChange={() => toggle(r.key)} />
                    <button type="button" className="rooms-name" onClick={() => setOpen(isOpen ? null : r.key)} aria-expanded={isOpen}>
                      <strong>{r.name}</strong>
                      {r.spellings.length > 1 && <span className="rooms-tag">{r.spellings.length} spellings</span>}
                      {flag && flag.to !== r.name && <span className="rooms-tag rooms-tag-warn">looks wrong</span>}
                      <span className="rooms-count">
                        {r.count} slot{r.count === 1 ? '' : 's'} {isOpen ? '▴' : '▾'}
                      </span>
                    </button>
                  </div>
                  {isOpen && (
                    <div className="rooms-uses">
                      {r.uses.map((u, i) => (
                        <div key={i}>
                          <b>{u.cls}</b> · {u.day} {u.time} · {u.subject}
                          {u.faculty ? ` · ${u.faculty}` : ''}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            {shown.length === 0 && <p className="rooms-lead">No room matches "{search}".</p>}
          </div>

          {rememberedList.length > 0 && (
            <details className="rooms-remembered">
              <summary>
                {rememberedList.length} remembered fix{rememberedList.length === 1 ? '' : 'es'} — applied automatically whenever a timetable
                is saved
              </summary>
              {rememberedList.map(([k, to]) => (
                <div key={k} className="rooms-remembered-row">
                  <span>
                    {k} → {to || <em>no room</em>}
                  </span>
                  <button
                    type="button"
                    className="exam-grid-x"
                    aria-label={`Forget ${k}`}
                    onClick={async () => {
                      try {
                        await forgetRoomAlias(k);
                        setAliases((a) => {
                          const n = { ...a };
                          delete n[k];
                          return n;
                        });
                      } catch (e) {
                        setStatus({ kind: 'error', text: `Could not forget it: ${(e as Error).message}` });
                      }
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </details>
          )}
        </>
      )}
    </div>
  );
}
