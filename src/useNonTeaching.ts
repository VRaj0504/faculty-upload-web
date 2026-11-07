import { useEffect, useState } from 'react';
import { doc, getDoc } from 'firebase/firestore';
import { db } from './firebaseConfig';

export function useNonTeaching(role: string | null, email: string | null): boolean {
  const [nonTeaching, setNonTeaching] = useState(false);
  useEffect(() => {
    if (role !== 'faculty' || !email) {
      setNonTeaching(false);
      return;
    }
    let alive = true;
    getDoc(doc(db, 'allowlist', email.toLowerCase()))
      .then((s) => alive && setNonTeaching(s.data()?.nonTeaching === true))
      .catch(() => alive && setNonTeaching(false));
    return () => {
      alive = false;
    };
  }, [role, email]);
  return nonTeaching;
}
