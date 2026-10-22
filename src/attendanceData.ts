

import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  where,
  writeBatch,
} from 'firebase/firestore';
import { auth, db } from './firebaseConfig';
import { subjectsFor } from './curriculum';
import {
  normCode,
  sessionDocId,
  type ClassGroup,
  type ExcusalRange,
  type RosterEntry,
  type SessionDoc,
} from './attendanceCore';

const SESSIONS = 'attendanceSessions';

export async function loadRoster(): Promise<RosterEntry[]> {
  const snap = await getDocs(collection(db, 'roster'));
  return snap.docs

    .filter((d) => d.data().reviewer !== true)
    .map((d) => {
      const x = d.data() as Partial<RosterEntry>;
      return {
        regNo: d.id,
        name: x.name ?? d.id,
        branch: x.branch ?? '',
        section: x.section ?? null,
        specialization: x.specialization ?? null,
        admissionYear: Number(x.admissionYear),
        program: x.program,
      } as RosterEntry;
    })
    .filter((r) => r.branch && r.admissionYear);
}

export async function loadHolidayOverrides(): Promise<Map<string, string>> {
  try {
    const snap = await getDocs(collection(db, 'holidayOverrides'));
    return new Map(snap.docs.map((d) => [d.id, String(d.data().name ?? 'Holiday')]));
  } catch {
    return new Map();
  }
}

export type SubjectOption = { code: string; name: string };

export async function loadSubjects(branches: string[], semester: number): Promise<SubjectOption[]> {
  const out = new Map<string, SubjectOption>();
  for (const branch of branches) {
    try {
      const snap = await getDocs(
        query(collection(db, 'curriculum'), where('branch', '==', branch), where('semester', '==', semester)),
      );
      snap.docs.forEach((d) => {
        const x = d.data() as { code?: string; name?: string };
        if (x.code && !out.has(normCode(x.code))) out.set(normCode(x.code), { code: x.code, name: x.name ?? x.code });
      });
    } catch {

    }
    for (const s of subjectsFor(branch, semester)) {
      if (!out.has(normCode(s.code))) out.set(normCode(s.code), { code: s.code, name: s.name });
    }
  }
  return Array.from(out.values()).sort((a, b) => a.code.localeCompare(b.code));
}

export async function loadClassSessions(
  cls: ClassGroup,
  admissionYear: number,
  subjectCode?: string,
): Promise<(SessionDoc & { id: string })[]> {
  const all: (SessionDoc & { id: string })[] = [];
  for (const t of cls.targets) {
    const filters = [
      where('branch', '==', t.branch),
      where('admissionYear', '==', admissionYear),
      where('section', '==', t.section),
    ];
    if (subjectCode) filters.push(where('subjectCode', '==', subjectCode));
    const snap = await getDocs(query(collection(db, SESSIONS), ...filters));
    snap.docs.forEach((d) => all.push({ id: d.id, ...(d.data() as SessionDoc) }));
  }
  return all.sort((a, b) => a.date.localeCompare(b.date) || (a.lecture ?? 1) - (b.lecture ?? 1));
}

export async function existingIds(ids: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < ids.length; i += 40) {
    const chunk = ids.slice(i, i + 40);
    const snaps = await Promise.all(chunk.map((id) => getDoc(doc(db, SESSIONS, id))));
    snaps.forEach((s) => s.exists() && found.add(s.id));
  }
  return found;
}

export async function getSession(id: string): Promise<SessionDoc | null> {
  const s = await getDoc(doc(db, SESSIONS, id));
  return s.exists() ? (s.data() as SessionDoc) : null;
}

export type SessionWrite = Omit<SessionDoc, 'markedBy' | 'markedAt' | 'markedByName'>;

export function splitByBranch(
  cls: ClassGroup,
  base: Omit<SessionWrite, 'branch' | 'section' | 'absentEnrollmentNumbers' | 'excusedEnrollmentNumbers' | 'classSize'>,
  absent: RosterEntry[],
  excused: RosterEntry[],
  classStudents: RosterEntry[],

  partOfClass = false,
): (SessionWrite & { id: string })[] {
  return cls.targets
    .map((t) => {
      const mine = classStudents.filter((s) => s.branch === t.branch);
      if (!mine.length) return null;
      const w: SessionWrite = {
        ...base,
        branch: t.branch,
        section: t.section,
        absentEnrollmentNumbers: absent.filter((s) => s.branch === t.branch).map((s) => s.regNo).sort(),
        excusedEnrollmentNumbers: excused.filter((s) => s.branch === t.branch).map((s) => s.regNo).sort(),
        classSize: mine.length,
        ...(partOfClass ? { onlyEnrollmentNumbers: mine.map((s) => s.regNo).sort() } : {}),
      };
      return { ...w, id: sessionDocId(w) };
    })
    .filter((x): x is SessionWrite & { id: string } => !!x);
}

export async function writeSessions(docs: (SessionWrite & { id: string })[], onProgress?: (done: number) => void) {
  const markedBy = auth.currentUser?.uid ?? 'web-portal';
  const markedByName = auth.currentUser?.displayName ?? auth.currentUser?.email ?? 'Faculty';

  for (let i = 0; i < docs.length; i += 450) {
    const batch = writeBatch(db);
    for (const { id, ...d } of docs.slice(i, i + 450)) {

      const clean = Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined));
      batch.set(doc(db, SESSIONS, id), { ...clean, markedBy, markedByName, markedAt: serverTimestamp() });
    }
    await batch.commit();
    onProgress?.(Math.min(i + 450, docs.length));
  }
}

export async function deleteSessions(ids: string[]) {
  await Promise.all(ids.map((id) => deleteDoc(doc(db, SESSIONS, id))));
}

export async function loadApprovedExcusals(regNos: Set<string>): Promise<{ map: Map<string, ExcusalRange[]>; ok: boolean }> {
  const map = new Map<string, ExcusalRange[]>();
  try {
    const snap = await getDocs(query(collection(db, 'eventExcusals'), where('status', '==', 'approved')));
    snap.docs.forEach((d) => {
      const x = d.data() as { studentEnrollmentNumbers?: string[]; fromDate: string; toDate: string; eventName?: string };
      for (const r of x.studentEnrollmentNumbers ?? []) {
        if (!regNos.has(r)) continue;
        map.set(r, [...(map.get(r) ?? []), { fromDate: x.fromDate, toDate: x.toDate, eventName: x.eventName }]);
      }
    });
    return { map, ok: true };
  } catch {
    return { map, ok: false };
  }
}
