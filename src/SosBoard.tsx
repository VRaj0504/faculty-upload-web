import { useEffect, useState } from 'react';
import { Timestamp, collection, doc, getDoc, onSnapshot, query, serverTimestamp, updateDoc, where } from 'firebase/firestore';
import { auth, db } from './firebaseConfig';
import { Icon } from './icons';
import type { SosAlert } from './useActiveSos';

const TYPE: Record<string, string> = { medical: 'Medical', safety: 'Safety', other: 'Emergency' };

function dur(ms: number) {
  const m = Math.max(1, Math.round(ms / 60000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} hr ${m % 60} min`;
}

type Closed = SosAlert & { resolvedBy?: { name: string; email: string; at: number } | null };

function SosHistory() {
  const [rows, setRows] = useState<Closed[] | null>(null);
  useEffect(() => {
    const q = query(collection(db, 'sosAlerts'), where('createdAt', '>=', Timestamp.fromMillis(Date.now() - 30 * 86400000)));
    return onSnapshot(
      q,
      (snap) => {
        const list = snap.docs
          .map((d) => ({ id: d.id, ...(d.data() as Omit<Closed, 'id'>) }))
          .filter((a) => a.status === 'resolved' || a.status === 'cancelled');
        list.sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
        setRows(list);
      },
      () => setRows([]),
    );
  }, []);
  if (!rows || rows.length === 0) return null;
  return (
    <div className="card" style={{ marginTop: '1.5rem' }}>
      <h2 style={{ fontSize: '1.05rem', marginTop: 0 }}>Closed in the last 30 days</h2>
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Student</th>
            <th>Type</th>
            <th>First response</th>
            <th>Closed</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => {
            const start = a.createdAt?.toMillis?.() ?? null;
            return (
              <tr key={a.id}>
                <td>{start ? new Date(start).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '—'}</td>
                <td>
                  {a.studentName}
                  {a.enrollmentNumber ? ` · ${a.enrollmentNumber}` : ''}
                </td>
                <td>{TYPE[a.type] ?? 'Emergency'}</td>
                <td>{a.ackBy && start ? `${a.ackBy.name} in ${dur(a.ackBy.at - start)}` : '—'}</td>
                <td>
                  {a.status === 'cancelled'
                    ? 'Student marked safe'
                    : a.resolvedBy && start
                      ? `${a.resolvedBy.name} after ${dur(a.resolvedBy.at - start)}`
                      : 'Resolved'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ago(ms: number) {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} hr ago`;
}

export default function SosBoard({
  alerts,
  me,
  viewOnly = false,
}: {
  alerts: SosAlert[] | null;
  me: { name: string; email: string };
  viewOnly?: boolean;
}) {
  const [, tick] = useState(0);
  const [responder, setResponder] = useState(!viewOnly);
  useEffect(() => {
    if (!viewOnly) return;
    getDoc(doc(db, 'config', 'sos'))
      .then((s) => setResponder(((s.data()?.responderEmails ?? []) as string[]).map((e) => String(e).toLowerCase()).includes(me.email.toLowerCase())))
      .catch(() => setResponder(false));
  }, [viewOnly, me.email]);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 30000);
    return () => clearInterval(id);
  }, []);

  const act = async (a: SosAlert, status: 'acknowledged' | 'resolved') => {
    if (status === 'resolved' && !confirm(`Mark ${a.studentName}'s SOS as resolved? It closes for everyone.`)) return;
    setBusy(a.id);
    try {
      const by = { name: me.name, email: me.email || auth.currentUser?.email || '', at: Date.now() };
      await updateDoc(doc(db, 'sosAlerts', a.id), {
        status,
        updatedAt: serverTimestamp(),
        ...(status === 'acknowledged' ? { ackBy: by } : { resolvedBy: by }),
      });
    } catch (e: any) {
      alert(`Couldn't update: ${e.message}`);
    } finally {
      setBusy(null);
    }
  };

  if (alerts === null) {
    return (
      <div className="card sos-empty">
        <h1>SOS alerts</h1>
        <p>Only the doctor, the wardens and admins can see SOS alerts. Ask the admin to add you to the SOS responders if you should.</p>
      </div>
    );
  }

  return (
    <div className="sos-page">
      <div className="res-head">
        <div>
          <h1>SOS alerts</h1>
          <p>Live from the student app. You also get a phone notification for each new one.</p>
        </div>
      </div>

      {alerts.length === 0 ? (
        <div className="card sos-empty">
          <span className="sos-ok"><Icon name="check" size={22} /></span>
          <h2>No active SOS</h2>
          <p>This page beeps and the banner turns red the moment a student presses SOS.</p>
        </div>
      ) : (
        <div className="sos-grid">
          {alerts.map((a) => {
            const open = a.status === 'open';
            const loc = a.location;
            const pad = 0.004;
            return (
              <article key={a.id} className={`sos-card${open ? ' sos-card-open' : ''}`}>
                <div className="sos-card-top">
                  <span className="sos-tag">{TYPE[a.type] ?? 'Emergency'}</span>
                  <span className="sos-when">{a.createdAt ? ago(a.createdAt.toMillis()) : 'just now'}</span>
                </div>
                <h2>{a.studentName}</h2>
                <p className="sos-meta">
                  {[a.enrollmentNumber, [a.branch, a.section].filter(Boolean).join(' ')].filter(Boolean).join(' · ')}
                </p>
                {a.note && <p className="sos-note">“{a.note}”</p>}
                {typeof a.smsSent === 'number' && (
                  <p className="sos-loc">
                    {a.smsSent > 0 ? `SMS sent to ${a.smsSent} (contacts + committees)` : 'SMS not sent — call the student'}
                  </p>
                )}
                <p className={`sos-status${open ? '' : ' sos-status-ack'}`}>
                  {open ? 'Waiting for a responder' : `${a.ackBy?.name ?? 'Someone'} is on the way`}
                </p>

                {loc ? (
                  <>
                    <iframe
                      className="sos-map"
                      title={`Location of ${a.studentName}`}
                      src={`https://www.openstreetmap.org/export/embed.html?bbox=${loc.lng - pad}%2C${loc.lat - pad}%2C${loc.lng + pad}%2C${loc.lat + pad}&layer=mapnik&marker=${loc.lat}%2C${loc.lng}`}
                    />
                    <p className="sos-loc">
                      Updated {ago(loc.at)}
                      {loc.accuracy ? ` · ±${Math.round(loc.accuracy)} m` : ''} ·{' '}
                      <a href={`https://maps.google.com/?q=${loc.lat},${loc.lng}`} target="_blank" rel="noreferrer">
                        Open in Google Maps
                      </a>
                    </p>
                  </>
                ) : (
                  <p className="sos-loc">No location shared — call the student.</p>
                )}

                <div className="sos-actions">
                  {!responder && <p className="sos-loc" style={{ flex: 1 }}>View only. The doctor and wardens respond to alerts.</p>}
                  {a.phone && (
                    <a className="button-secondary sos-call" href={`tel:${a.phone}`}>
                      Call {a.phone}
                    </a>
                  )}
                  {responder && open && (
                    <button type="button" className="sos-go" disabled={busy === a.id} onClick={() => act(a, 'acknowledged')}>
                      I'm on my way
                    </button>
                  )}
                  {responder && (
                    <button type="button" className="sos-done" disabled={busy === a.id} onClick={() => act(a, 'resolved')}>
                      Resolved
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
      <SosHistory />
    </div>
  );
}
