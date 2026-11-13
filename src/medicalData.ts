import { collection, doc, getDoc, onSnapshot, orderBy, query, serverTimestamp, setDoc, Timestamp, where } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { deleteObject, getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import { db, functions, storage } from './firebaseConfig';

export const LATE_LIMIT_DAYS = 4;
export const TEMPLATE_URL = '/forms/IIITS-Medical-Leave-Form.pdf';

export type Sig = { w: number; h: number; paths: string[]; png?: string };
export type SignRole = 'medical' | 'hod' | 'dean' | 'jr';
export type Sign = {
  decision: 'approved' | 'not_approved';
  comment?: string | null;
  byName: string;
  byEmail: string;
  designation?: string | null;
  signature: Sig;
  at?: Timestamp | null;
};
export type Kind = 'report' | 'intimation' | 'certificate' | 'other';
export type Att = { id: string; kind: Kind; name: string; path: string; contentType: string; size: number; byRole?: 'student' | 'medical' };
export type Stage = 'office' | 'returned' | 'medical' | 'signoff' | 'teachers' | 'done' | 'rejected' | 'withdrawn';

export type Med = {
  id: string;
  flow: 2;
  type: 'medical';
  stage: Stage;
  status: string;
  refNo?: string;
  studentUid: string;
  studentName: string;
  studentEnrollmentNumber?: string | null;
  studentEmail?: string | null;
  branch?: string | null;
  section?: string | null;
  semester?: number | null;
  yearOfStudy?: number | null;
  cgpa?: string | null;
  reason: string;
  fromDate: string;
  toDate: string;
  rejoinedOn: string;
  intimationSent?: boolean;
  intimationDate?: string | null;
  intimationLate?: boolean;
  intimationMissing?: boolean;
  attachments?: Att[];
  officeEmail: string;
  medicalEmail: string;
  medicalName?: string | null;
  hodEmail: string;
  hodName?: string | null;
  hodDepartment?: string | null;
  deanEmail: string;
  deanName?: string | null;
  jrEmail: string;
  jrName?: string | null;
  officeReview?: { action: string; note?: string | null; byName: string; at?: Timestamp | null } | null;
  medicalSign?: Sign | null;
  hodSign?: Sign | null;
  deanSign?: Sign | null;
  jrSign?: Sign | null;
  late?: boolean;
  daysAfterRejoining?: number | null;
  finalDecision?: string | null;
  returnNote?: string | null;
  returnedBy?: string | null;
  resubmissions?: number;
  pendingEmails?: string[];
  formPdfPath?: string | null;
  bundlePath?: string | null;
  teacherNote?: string | null;
  submittedAt?: Timestamp | null;
  createdAt?: Timestamp | null;
  decidedAt?: Timestamp | null;
};

export type Ev = { id: string; at?: Timestamp | null; byName: string; role: string; action: string; decision?: string | null; note?: string | null };

export const ROLE_TITLE: Record<SignRole, string> = {
  medical: 'Medical Officer',
  hod: 'HOD',
  dean: 'Associate Dean (Academics)',
  jr: 'Joint Registrar',
};
export const SIGNOFF: SignRole[] = ['hod', 'dean', 'jr'];
export const ALL_ROLES: SignRole[] = ['medical', 'hod', 'dean', 'jr'];

export const KIND_LABEL: Record<Kind, string> = {
  report: 'Medical report',
  intimation: 'Intimation email',
  certificate: 'Verified certificate',
  other: 'Other document',
};

export const STAGE_LABEL: Record<Stage, string> = {
  office: 'With Academic Office',
  returned: 'Returned to student',
  medical: 'With Medical Officer',
  signoff: 'Awaiting signatures',
  teachers: 'Approved',
  done: 'Approved',
  rejected: 'Not approved',
  withdrawn: 'Withdrawn',
};

export const STAGE_TONE: Record<Stage, string> = {
  office: 'blue',
  returned: 'amber',
  medical: 'blue',
  signoff: 'blue',
  teachers: 'green',
  done: 'green',
  rejected: 'red',
  withdrawn: 'grey',
};

const toMed = (d: { id: string; data: () => unknown }) => ({ id: d.id, ...(d.data() as Omit<Med, 'id'>) }) as Med;
const isFlow2 = (m: Med) => m.flow === 2 && m.type === 'medical';
const ts = (m: Med) => m.submittedAt?.toMillis?.() ?? m.createdAt?.toMillis?.() ?? 0;
const newest = (a: Med, b: Med) => ts(b) - ts(a);

export function watchQueue(email: string, cb: (m: Med[]) => void, fail: (e: Error) => void) {
  return onSnapshot(
    query(collection(db, 'leaveApplications'), where('pendingEmails', 'array-contains', email)),
    (s) => cb(s.docs.map(toMed).filter(isFlow2).sort(newest)),
    fail,
  );
}

export function watchRecords(email: string, admin: boolean, cb: (m: Med[]) => void, fail: (e: Error) => void) {
  const q = admin
    ? query(collection(db, 'leaveApplications'), where('flow', '==', 2))
    : query(collection(db, 'leaveApplications'), where('viewerEmails', 'array-contains', email));
  return onSnapshot(q, (s) => cb(s.docs.map(toMed).filter(isFlow2).sort(newest)), fail);
}

export function watchEvents(id: string, cb: (e: Ev[]) => void) {
  return onSnapshot(
    query(collection(db, 'leaveApplications', id, 'events'), orderBy('at', 'asc')),
    (s) => cb(s.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Ev, 'id'>) }))),
    () => cb([]),
  );
}

export async function openFile(path: string) {
  const w = window.open('', '_blank');
  if (w) w.opener = null;
  try {
    const url = await getDownloadURL(ref(storage, path));
    if (w) w.location.href = url;
    else window.location.href = url;
  } catch {
    w?.close();
    alert('Could not open the file. Check your connection and try again.');
  }
}

export async function uploadCertificate(m: Med, file: File): Promise<Att> {
  const type = file.type || (/\.pdf$/i.test(file.name) ? 'application/pdf' : 'image/jpeg');
  if (!/^image\/(jpeg|png|webp|heic|heif)$/.test(type) && type !== 'application/pdf') throw new Error('Attach a PDF or a photo.');
  if (file.size > 10 * 1024 * 1024) throw new Error('The file is over 10 MB.');
  const id = Math.random().toString(36).slice(2, 10);
  const path = `medicalLeaves/${m.studentUid}/${m.id}/medical/${id}-${file.name.replace(/[^a-zA-Z0-9.\-_]/g, '_').slice(-80)}`;
  await uploadBytes(ref(storage, path), file, { contentType: type });
  return { id, kind: 'certificate', name: file.name, path, contentType: type, size: file.size };
}

export async function removeFile(path: string) {
  await deleteObject(ref(storage, path)).catch(() => undefined);
}

function msg(e: unknown): string {
  const m = String((e as Error)?.message ?? '').replace(/^FirebaseError:\s*/, '');
  if (/unavailable|network|failed to fetch/i.test(m)) return 'No internet connection. Try again.';
  return m || 'Something went wrong. Try again.';
}

export async function act(input: {
  leaveId: string;
  action: 'forward' | 'return' | 'sign' | 'rebuild';
  role?: SignRole;
  decision?: 'approved' | 'not_approved';
  comment?: string;
  note?: string;
  signature?: Sig;
  saveSignature?: boolean;
  attachments?: Att[];
}) {
  try {
    return (await httpsCallable(functions, 'medicalAct')(input)).data as { stage: Stage };
  } catch (e) {
    throw new Error(msg(e));
  }
}

export async function loadSignature(uid: string): Promise<Sig | null> {
  try {
    const s = await getDoc(doc(db, 'signatures', uid));
    const d = s.data() as Sig | undefined;
    if (d?.png) return { w: d.w, h: d.h, paths: [], png: d.png };
    return d?.paths?.length ? { w: d.w, h: d.h, paths: d.paths } : null;
  } catch {
    return null;
  }
}

export async function saveSignature(uid: string, name: string, sig: Sig) {
  await setDoc(doc(db, 'signatures', uid), { w: sig.w, h: sig.h, paths: sig.png ? [] : sig.paths, ...(sig.png ? { png: sig.png } : {}), name, updatedAt: serverTimestamp() });
}

export async function signatureFromImage(file: File): Promise<Sig> {
  if (!/^image\/(png|jpeg|jpg|webp|heic|heif)$/i.test(file.type || '') && !/\.(png|jpe?g|webp)$/i.test(file.name)) throw new Error('Upload a photo or PNG of your signature.');
  if (file.size > 8 * 1024 * 1024) throw new Error('That image is over 8 MB.');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, bad) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = () => bad(new Error('Could not read that image. Try a PNG or JPG.'));
      i.src = url;
    });
    const max = 1400;
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const W = Math.max(1, Math.round(img.naturalWidth * k));
    const H = Math.max(1, Math.round(img.naturalHeight * k));
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const x = c.getContext('2d')!;
    x.drawImage(img, 0, 0, W, H);
    const d = x.getImageData(0, 0, W, H);
    const px = d.data;
    let sum = 0;
    for (let i = 0; i < px.length; i += 4) sum += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    const bg = sum / (px.length / 4);
    const cut = Math.min(200, bg - 45);
    let minX = W, minY = H, maxX = -1, maxY = -1;
    for (let y = 0; y < H; y++) {
      for (let xx = 0; xx < W; xx++) {
        const i = (y * W + xx) * 4;
        const lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
        const ink = px[i + 3] > 40 && lum < cut;
        if (!ink) {
          px[i + 3] = 0;
          continue;
        }
        const a = Math.min(255, Math.round(((cut - lum) / Math.max(1, cut)) * 255 * 1.8) + 60);
        px[i] = 0x1e;
        px[i + 1] = 0x2a;
        px[i + 2] = 0x78;
        px[i + 3] = a;
        if (xx < minX) minX = xx;
        if (xx > maxX) maxX = xx;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (maxX < 0 || maxX - minX < 8 || maxY - minY < 4) throw new Error('No signature found in that image. Sign in dark ink on white paper and try again.');
    x.putImageData(d, 0, 0);
    const padd = 6;
    const sx = Math.max(0, minX - padd), sy = Math.max(0, minY - padd);
    const sw = Math.min(W, maxX + padd) - sx, sh = Math.min(H, maxY + padd) - sy;
    let k2 = Math.min(1, 600 / sw, 220 / sh);
    for (let tries = 0; tries < 6; tries++) {
      const out = document.createElement('canvas');
      out.width = Math.max(1, Math.round(sw * k2));
      out.height = Math.max(1, Math.round(sh * k2));
      out.getContext('2d')!.drawImage(c, sx, sy, sw, sh, 0, 0, out.width, out.height);
      const png = out.toDataURL('image/png').split(',')[1];
      if (png.length <= 120000) return { w: out.width, h: out.height, paths: [], png };
      k2 *= 0.75;
    }
    throw new Error('That signature image is too detailed. Crop it closer and try again.');
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function myRoles(m: Med, email: string): SignRole[] {
  const out: SignRole[] = [];
  if (m.stage === 'medical' && m.medicalEmail === email && !m.medicalSign) out.push('medical');
  if (m.stage === 'signoff') for (const k of SIGNOFF) if (m[`${k}Email` as const] === email && !m[`${k}Sign` as const]) out.push(k);
  return out;
}

export function signOf(m: Med, r: SignRole): Sign | null | undefined {
  return m[`${r}Sign` as const];
}

export function nameFor(m: Med, r: SignRole): string {
  return (r === 'medical' ? m.medicalName : m[`${r}Name` as const]) || ROLE_TITLE[r];
}

export function prettyIso(iso?: string | null): string {
  if (!iso) return '';
  const [y, mo, d] = iso.split('-').map(Number);
  if (!y || !mo || !d) return iso;
  return new Date(y, mo - 1, d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function stamp(t?: Timestamp | null): string {
  if (!t?.toDate) return '';
  return t.toDate().toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function daysOf(m: Med): number {
  const a = Date.parse(`${m.fromDate}T00:00:00Z`);
  const b = Date.parse(`${m.toDate}T00:00:00Z`);
  return Math.round((b - a) / 864e5) + 1;
}

const csvCell = (v: unknown) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(list: Med[]): string {
  const head = [
    'Ref No', 'Student', 'Reg No', 'Branch', 'Semester', 'CGPA', 'From', 'To', 'Days', 'Rejoined', 'Submitted', 'Days after rejoining', 'Late',
    'Intimation sent', 'Intimation date', 'Reason', 'HOD', 'Status', 'Medical Officer', 'HOD decision', 'Dean decision', 'JR decision', 'Decided on',
  ];
  const dec = (s?: Sign | null) => (s ? `${s.decision === 'approved' ? 'Approved' : 'Not approved'}${s.comment ? ` (${s.comment})` : ''}` : '');
  const rows = list.map((m) => [
    m.refNo, m.studentName, m.studentEnrollmentNumber, m.branch, m.semester, m.cgpa, m.fromDate, m.toDate, daysOf(m), m.rejoinedOn, stamp(m.submittedAt),
    m.daysAfterRejoining, m.late ? 'Yes' : 'No', m.intimationSent ? 'Yes' : 'No', m.intimationDate, m.reason, m.hodName, STAGE_LABEL[m.stage],
    dec(m.medicalSign), dec(m.hodSign), dec(m.deanSign), dec(m.jrSign), stamp(m.decidedAt),
  ]);
  return [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
}
