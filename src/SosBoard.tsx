import { useEffect, useState } from 'react';
import { doc, serverTimestamp, updateDoc } from 'firebase/firestore';
import { auth, db } from './firebaseConfig';
import { Icon } from './icons';
import type { SosAlert } from './useActiveSos';

const TYPE: Record<string, string> = { medical: 'Medical', safety: 'Safety', other: 'Emergency' };

function ago(ms: number) {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} hr ago`;
}

export default function SosBoard({ alerts, me }: { alerts: SosAlert[] | null; me: { name: string; email: string } }) {
  const [, tick] = useState(0);
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
                  {a.phone && (
                    <a className="button-secondary sos-call" href={`tel:${a.phone}`}>
                      Call {a.phone}
                    </a>
                  )}
                  {open && (
                    <button type="button" className="sos-go" disabled={busy === a.id} onClick={() => act(a, 'acknowledged')}>
                      I'm on my way
                    </button>
                  )}
                  <button type="button" className="sos-done" disabled={busy === a.id} onClick={() => act(a, 'resolved')}>
                    Resolved
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
