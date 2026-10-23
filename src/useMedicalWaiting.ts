import { useEffect, useState } from 'react';
import { collection, collectionGroup, onSnapshot, query, where } from 'firebase/firestore';
import { db } from './firebaseConfig';

const ROLES = ['doctor', 'dr', 'dean', 'hod'] as const;

export function useMedicalWaiting(email: string | null): number | null {
  const [parts, setParts] = useState<(number | null)[]>([null, null, null, null, null]);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!email) return;
    setParts([null, null, null, null, null]);
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
          (s) => set(i)(s.docs.filter((d) => d.data().stage === role).length),
          fail,
        ),
      ),
      onSnapshot(
        query(collectionGroup(db, 'teacherAcks'), where('email', '==', email)),
        (s) => set(ROLES.length)(s.docs.filter((d) => d.data().status === 'pending').length),
        fail,
      ),
    ];
    return () => unsubs.forEach((u) => u());
  }, [email]);

  if (!email || failed || parts.some((p) => p === null)) return null;
  return parts.reduce<number>((n, p) => n + (p ?? 0), 0);
}
