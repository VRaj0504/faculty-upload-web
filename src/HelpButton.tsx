import { useEffect, useState } from 'react';
import { addDoc, collection, doc, onSnapshot, query, serverTimestamp, updateDoc, where } from 'firebase/firestore';
import { auth, db } from './firebaseConfig';
import { Icon } from './icons';
import { NAV } from './nav';
import { SUPPORT } from './support';

// A Help button on every screen. Faculty pick what went wrong and where
// (dropdowns, not free text), add a line of detail, and it lands in the
// `supportRequests` collection — admins see the open ones right here. They
// can also email (or WhatsApp) support directly, with the page and their
// details already filled in.

const CATEGORIES = [
  'Something is not working / shows an error',
  'Wrong data (timetable, students, subjects, rooms)',
  'Upload failed',
  'I don’t know how to do something',
  'Medical leave / approvals',
  'Suggestion or new feature',
  'Other',
];

type Request = {
  id: string;
  category: string;
  page: string;
  details: string;
  name: string;
  email: string;
  status: 'open' | 'resolved';
  createdAt?: { toDate: () => Date } | null;
};

export default function HelpButton({
  role,
  name,
  email,
  currentPage,
}: {
  role: string | null;
  name: string;
  email: string;
  currentPage: string;
}) {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState('');
  const [page, setPage] = useState(currentPage);
  const [details, setDetails] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState('');
  const [error, setError] = useState('');
  const [requests, setRequests] = useState<Request[] | null>(null);
  const isAdmin = role === 'admin';

  useEffect(() => {
    if (open) setPage(currentPage);
  }, [open, currentPage]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Admins see open requests from everyone.
  useEffect(() => {
    if (!open || !isAdmin) return;
    // One equality filter only (no composite index needed); newest first is sorted here.
    const q = query(collection(db, 'supportRequests'), where('status', '==', 'open'));
    return onSnapshot(
      q,
      (snap) =>
        setRequests(
          snap.docs
            .map((d) => ({ id: d.id, ...(d.data() as Omit<Request, 'id'>) }))
            .sort((a, b) => (b.createdAt?.toDate?.().getTime() ?? 0) - (a.createdAt?.toDate?.().getTime() ?? 0)),
        ),
      () => setRequests([]),
    );
  }, [open, isAdmin]);

  const pages = ['Home', ...NAV.flatMap((g) => g.items.map((i) => i.label)), 'Login / account'];

  const submit = async () => {
    setError('');
    if (!category) return setError('Pick what the problem is about.');
    if (details.trim().length < 5) return setError('Add a line about what happened.');
    setSending(true);
    try {
      await addDoc(collection(db, 'supportRequests'), {
        category,
        page,
        details: details.trim(),
        name,
        email,
        uid: auth.currentUser?.uid ?? null,
        status: 'open',
        url: window.location.href,
        userAgent: navigator.userAgent.slice(0, 200),
        createdAt: serverTimestamp(),
      });
      setSent('Sent. We’ll get back to you by email.');
      setCategory('');
      setDetails('');
    } catch {
      setError('Couldn’t send it from here — use the email button below instead.');
    } finally {
      setSending(false);
    }
  };

  const mailBody = encodeURIComponent(
    `Page: ${page}\nProblem: ${category || '-'}\n\n${details || '(describe what happened)'}\n\n— ${name} (${email})`,
  );
  const mailto = `mailto:${SUPPORT.email}?subject=${encodeURIComponent(`Faculty portal help: ${category || page}`)}&body=${mailBody}`;
  const whatsapp = SUPPORT.phone
    ? `https://wa.me/${SUPPORT.phone}?text=${encodeURIComponent(`Faculty portal help (${page}): ${details || category}`)}`
    : '';

  const resolve = (id: string) => updateDoc(doc(db, 'supportRequests', id), { status: 'resolved', resolvedAt: serverTimestamp() }).catch(() => {});

  return (
    <>
      <button type="button" className="help-fab" onClick={() => setOpen(true)} aria-label="Help — report a problem">
        <Icon name="help" size={20} />
        <span>Help</span>
      </button>

      {open && (
        <div className="help-overlay" onClick={() => setOpen(false)}>
          <div className="help-panel" role="dialog" aria-modal="true" aria-label="Help" onClick={(e) => e.stopPropagation()}>
            <div className="help-head">
              <div>
                <h2>Need help?</h2>
                <p>Tell us what went wrong — it reaches the portal team directly.</p>
              </div>
              <button type="button" className="icon-button" onClick={() => setOpen(false)} aria-label="Close">
                <Icon name="close" size={20} />
              </button>
            </div>

            <label>What is it about?</label>
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">Select…</option>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>

            <label style={{ marginTop: '0.8rem' }}>Which page?</label>
            <select value={page} onChange={(e) => setPage(e.target.value)}>
              {pages.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>

            <label style={{ marginTop: '0.8rem' }}>What happened?</label>
            <textarea
              rows={4}
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              placeholder="e.g. Clicked Save on CSE Sem 3 B timetable and it said “permission denied”."
            />

            {error && <div className="notice notice-error">{error}</div>}
            {sent && <div className="notice notice-ok">{sent}</div>}

            <button type="button" onClick={submit} disabled={sending} style={{ width: '100%', marginTop: '0.9rem' }}>
              {sending ? 'Sending…' : 'Send to support'}
            </button>

            <div className="help-direct">
              <span>Or contact directly</span>
              <div className="help-direct-row">
                <a className="help-link" href={mailto}>
                  <Icon name="mail" size={16} /> Email {SUPPORT.email}
                </a>
                {whatsapp && (
                  <a className="help-link" href={whatsapp} target="_blank" rel="noreferrer">
                    <Icon name="chat" size={16} /> WhatsApp
                  </a>
                )}
                {SUPPORT.phone && (
                  <a className="help-link" href={`tel:+${SUPPORT.phone}`}>
                    📞 Call +{SUPPORT.phone.slice(0, 2)} {SUPPORT.phone.slice(2)}
                  </a>
                )}
              </div>
              <small>Tip: a screenshot of the problem helps — attach it to the email.</small>
            </div>

            {isAdmin && (
              <div className="help-admin">
                <strong>Open requests {requests ? `(${requests.length})` : ''}</strong>
                {requests === null ? (
                  <p className="res-hint">Loading…</p>
                ) : requests.length === 0 ? (
                  <p className="res-hint">Nothing open.</p>
                ) : (
                  <ul>
                    {requests.map((r) => (
                      <li key={r.id}>
                        <div>
                          <b>{r.category}</b> · {r.page}
                          <p>{r.details}</p>
                          <small>
                            {r.name} · <a href={`mailto:${r.email}`}>{r.email}</a>
                            {r.createdAt?.toDate ? ` · ${r.createdAt.toDate().toLocaleString('en-IN')}` : ''}
                          </small>
                        </div>
                        <button type="button" className="button-secondary" onClick={() => resolve(r.id)}>Resolved</button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
