import { collection, doc, getDoc, getDocs, query, serverTimestamp, Timestamp, where, writeBatch } from 'firebase/firestore';
import { auth, db } from './firebaseConfig';
import { curriculum as staticCurriculum } from './curriculum';
import { COURSE_CREDITS } from './curriculumCredits';
import type { AttemptType, ResultInput } from './examRules';

export type RosterRow = {
  regNo: string;
  name: string;
  branch: string;
  section: string | null;
  admissionYear: number;
};

export type SubjectInfo = {
  branch: string;
  code: string;
  name: string;
  semester: number;
  credits: number | null;
};

export type HistoryEntry = { grade: string; attempt?: string | null; enteredByName?: string | null; changedAt?: Timestamp | null };

export type GradeDoc = ResultInput & {
  id: string;
  studentEnrollmentNumber: string;
  studentName: string;
  studentUid?: string | null;
  branch: string;
  section: string | null;
  admissionYear: number;
  attempt?: AttemptType | null;
  history?: HistoryEntry[] | null;
  enteredBy?: string;
  enteredByName?: string;
  createdAt?: Timestamp | null;
};

export const subjectKey = (branch: string, code: string) => `${branch.toUpperCase()}:${code.toUpperCase().replace(/\s+/g, '')}`;
export const gradeDocId = (regNo: string, code: string) => `${regNo}_${code}`;

export async function loadRoster(): Promise<RosterRow[]> {
  const snap = await getDocs(collection(db, 'roster'));
  return snap.docs
    .filter((d) => d.data().reviewer !== true)
    .map((d) => {
      const data = d.data() as { name?: string; branch?: string; section?: string | null; admissionYear?: number };
      return {
        regNo: d.id,
        name: data.name ?? '',
        branch: data.branch ?? '',
        section: data.section || null,
        admissionYear: Number(data.admissionYear),
      };
    });
}

export async function loadSubjectIndex(): Promise<Map<string, SubjectInfo>> {
  const index = new Map<string, SubjectInfo>();
  for (const [branch, sems] of Object.entries(staticCurriculum)) {
    for (const [sem, subjects] of Object.entries(sems)) {
      for (const s of subjects) {
        index.set(subjectKey(branch, s.code), {
          branch,
          code: s.code,
          name: s.name,
          semester: Number(sem),
          credits: COURSE_CREDITS[s.code] ?? null,
        });
      }
    }
  }
  try {
    const snap = await getDocs(collection(db, 'curriculum'));
    snap.forEach((d) => {
      const c = d.data() as { branch?: string; semester?: number; code?: string; name?: string; credits?: number };
      if (!c.branch || !c.code || !c.semester) return;
      const key = subjectKey(c.branch, c.code);
      const prev = index.get(key);
      index.set(key, {
        branch: c.branch,
        code: c.code,
        name: c.name || prev?.name || c.code,
        semester: Number(c.semester),
        credits: typeof c.credits === 'number' && c.credits > 0 ? c.credits : prev?.credits ?? COURSE_CREDITS[c.code] ?? null,
      });
    });
  } catch {
    return index;
  }
  return index;
}

export async function loadGrades(admissionYear: number, branch: string): Promise<GradeDoc[]> {
  const snap = await getDocs(
    query(collection(db, 'grades'), where('branch', '==', branch), where('admissionYear', '==', admissionYear)),
  );
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<GradeDoc, 'id'>) }));
}

export function groupByStudent(grades: GradeDoc[]): Map<string, GradeDoc[]> {
  const m = new Map<string, GradeDoc[]>();
  for (const g of grades) {
    const list = m.get(g.studentEnrollmentNumber) ?? [];
    list.push(g);
    m.set(g.studentEnrollmentNumber, list);
  }
  return m;
}

export function composeGradeDoc(
  existing: GradeDoc | null | undefined,
  next: {
    student: RosterRow;
    subject: SubjectInfo;
    credits: number;
    grade: string;
    attempt: AttemptType;
  },
) {
  const uid = auth.currentUser?.uid ?? '';
  const name = auth.currentUser?.email ?? 'Exam cell';
  const history: HistoryEntry[] = [...(existing?.history ?? [])];
  const prevAttempt = existing?.attempt ?? 'regular';
  if (existing?.grade && existing.grade !== next.grade && next.attempt !== prevAttempt) {
    history.push({
      grade: existing.grade,
      attempt: prevAttempt,
      enteredByName: existing.enteredByName ?? null,
      changedAt: Timestamp.now(),
    });
  }
  return {
    studentEnrollmentNumber: next.student.regNo,
    studentName: next.student.name,
    studentUid: existing?.studentUid ?? null,
    branch: next.student.branch,
    section: next.student.section,
    admissionYear: next.student.admissionYear,
    subjectCode: next.subject.code,
    subjectName: next.subject.name,
    subjectSemester: next.subject.semester,
    credits: next.credits,
    grade: next.grade,
    attempt: next.attempt,
    history,
    enteredBy: uid,
    enteredByName: name,
    createdAt: existing?.createdAt ?? serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
}

export async function writeGradeDocs(
  items: { id: string; data: ReturnType<typeof composeGradeDoc> }[],
  onProgress?: (done: number) => void,
) {
  const CHUNK = 400;
  for (let i = 0; i < items.length; i += CHUNK) {
    const batch = writeBatch(db);
    for (const item of items.slice(i, i + CHUNK)) batch.set(doc(db, 'grades', item.id), item.data);
    await batch.commit();
    onProgress?.(Math.min(items.length, i + CHUNK));
  }
}

export type ExamAccess = {
  loading: boolean;
  full: boolean;
  examCell: boolean;
  hodBranches: string[];
};

export async function loadExamAccess(email: string, role: string | null): Promise<Omit<ExamAccess, 'loading'>> {
  const me = email.toLowerCase();
  let examCell = false;
  const hodBranches: string[] = [];
  try {
    const exams = await getDoc(doc(db, 'config', 'exams'));
    const list = (exams.data()?.examCellEmails ?? []) as string[];
    examCell = list.map((e) => e.toLowerCase()).includes(me);
  } catch {
    examCell = false;
  }
  try {
    const ml = await getDoc(doc(db, 'config', 'medicalLeave'));
    const byBranch = (ml.data()?.hodByBranch ?? {}) as Record<string, { email?: string }>;
    for (const [branch, h] of Object.entries(byBranch)) if ((h?.email ?? '').toLowerCase() === me) hodBranches.push(branch);
  } catch {
    return { full: role === 'admin' || examCell, examCell, hodBranches };
  }
  return { full: role === 'admin' || examCell, examCell, hodBranches };
}
