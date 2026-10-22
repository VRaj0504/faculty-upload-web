import { useEffect, useRef, useState } from 'react';
import { collection, onSnapshot, query, where, type Timestamp } from 'firebase/firestore';
import { db } from './firebaseConfig';

export type SosAlert = {
  id: string;
  studentUid: string;
  studentName: string;
  enrollmentNumber: string | null;
  branch: string | null;
  section: string | null;
  phone: string | null;
  type: 'medical' | 'safety' | 'other';
  note: string;
  status: 'open' | 'acknowledged' | 'resolved' | 'cancelled';
  location: { lat: number; lng: number; accuracy: number | null; at: number } | null;
  ackBy: { name: string; email: string; at: number } | null;
  createdAt: Timestamp | null;
  smsSent?: number;
  smsError?: string | null;
};

function beep() {
  try {
    const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    [880, 660, 880].forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = f;
      o.connect(g);
      g.connect(ctx.destination);
      const t = ctx.currentTime + i * 0.22;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
      o.start(t);
      o.stop(t + 0.21);
    });
  } catch {

  }
}

export function useActiveSos(enabled: boolean): SosAlert[] | null {
  const [alerts, setAlerts] = useState<SosAlert[] | null>(null);
  const seen = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (!enabled) {
      setAlerts(null);
      return;
    }
    const q = query(collection(db, 'sosAlerts'), where('status', 'in', ['open', 'acknowledged']));
    return onSnapshot(
      q,
      (snap) => {
        const list = snap.docs
          .map((d) => ({ id: d.id, ...(d.data() as Omit<SosAlert, 'id'>) }))
          .sort((a, b) => (b.createdAt?.toMillis?.() ?? Date.now()) - (a.createdAt?.toMillis?.() ?? Date.now()));
        const ids = new Set(list.map((a) => a.id));
        if (seen.current && list.some((a) => !seen.current!.has(a.id) && a.status === 'open')) beep();
        seen.current = ids;
        setAlerts(list);
      },
      () => setAlerts(null),
    );
  }, [enabled]);

  return alerts;
}
