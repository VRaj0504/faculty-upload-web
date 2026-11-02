import { useEffect, useState } from 'react';
import { collection, collectionGroup, onSnapshot, query, where } from 'firebase/firestore';
import { db } from './firebaseConfig';

const ROLES = ['doctor', 'hod', 'dean', 'jr', 'administrator'] as const;

export function useMedicalWaiting(email: string | null): number | null {
  const [parts, setParts] = useState<(number | null)[]>(Array(ROLES.length + 2).fill(null));
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!email) return;
    setParts(Array(ROLES.length + 2).fill(null));
    setFailed(false);
    const set = (i: number) => (n: number) =>
      setParts((p) => {
        const next = [...p];
        next[i] = n;
        return next;
      });
    const fail = () => setFailed(true);
    const unsubs = [
      ...ROLES.map((role, i) =>
        onSnapshot(
          query(collection(db, 'leaveApplications'), where(`${role}Email`, '==', email)),
          (s) => set(i)(s.docs.filter((d) => d.data().stage === role && d.data().flow !== 2).length),
          fail,
        ),
      ),
      onSnapshot(
        query(collectionGroup(db, 'teacherAcks'), where('email', '==', email)),
        (s) => set(ROLES.length)(s.docs.filter((d) => d.data().status === 'pending').length),
        fail,
      ),
      onSnapshot(
        query(collection(db, 'leaveApplications'), where('pendingEmails', 'array-contains', email)),
        (s) => set(ROLES.length + 1)(s.docs.filter((d) => d.data().flow === 2).length),
        fail,
      ),
    ];
    return () => unsubs.forEach((u) => u());
  }, [email]);

  if (!email || failed || parts.some((p) => p === null)) return null;
  return parts.reduce<number>((n, p) => n + (p ?? 0), 0);
}
