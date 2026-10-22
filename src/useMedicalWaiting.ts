import { useEffect, useState } from 'react';
import { collection, collectionGroup, onSnapshot, query, where } from 'firebase/firestore';
import { db } from './firebaseConfig';

export function useMedicalWaiting(email: string | null): number | null {
  const [parts, setParts] = useState<[number | null, number | null, number | null]>([null, null, null]);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!email) return;
    setParts([null, null, null]);
    setFailed(false);
    const set = (i: 0 | 1 | 2) => (n: number) =>
      setParts((p) => {
        const next = [...p] as typeof p;
        next[i] = n;
        return next;
      });
    const fail = () => setFailed(true);
    const unsubs = [
      onSnapshot(
        query(collection(db, 'leaveApplications'), where('doctorEmail', '==', email)),
        (s) => set(0)(s.docs.filter((d) => d.data().stage === 'doctor').length),
        fail,
      ),
      onSnapshot(
        query(collection(db, 'leaveApplications'), where('hodEmail', '==', email)),
        (s) => set(1)(s.docs.filter((d) => d.data().stage === 'hod').length),
        fail,
      ),
      onSnapshot(
        query(collectionGroup(db, 'teacherAcks'), where('email', '==', email)),
        (s) => set(2)(s.docs.filter((d) => d.data().status === 'pending').length),
        fail,
      ),
    ];
    return () => unsubs.forEach((u) => u());
  }, [email]);

  if (!email || failed || parts.some((p) => p === null)) return null;
  return (parts[0] ?? 0) + (parts[1] ?? 0) + (parts[2] ?? 0);
}
