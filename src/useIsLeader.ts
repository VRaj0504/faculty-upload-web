import { useEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from './firebaseConfig';

export function useIsLeader(role: string | null, email: string | null): boolean {
  const [emails, setEmails] = useState<string[]>([]);
  useEffect(() => {
    if (role !== 'faculty' && role !== 'admin') return;
    return onSnapshot(
      doc(db, 'config', 'leadership'),
      (s) => setEmails(((s.data()?.emails ?? []) as string[]).map((e) => String(e).toLowerCase())),
      () => setEmails([]),
    );
  }, [role]);
  if (role === 'admin') return true;
  return !!email && emails.includes(email.toLowerCase());
}
