import { useEffect, useState } from 'react';
import { signOut, sendEmailVerification, type User } from 'firebase/auth';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { auth, db } from './firebaseConfig';
import { SUPPORT } from './support';
import BrandLoader from './BrandLoader';
import { COLLEGE_EMAIL_DOMAIN } from './college';

type Props = { user: User; step: 'verify' | 'create'; onReady: (name: string) => void };

export default function FacultySetup({ user, step, onReady }: Props) {
  const [stage, setStage] = useState(step);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);
  const [notListed, setNotListed] = useState(false);
  const email = (user.email ?? '').toLowerCase();

  useEffect(() => {
    if (stage !== 'create') return;
    let cancelled = false;
    (async () => {
      setError('');
      try {
        await user.getIdToken(true);
        const allow = await getDoc(doc(db, 'allowlist', email));
        const a = allow.data() as { role?: string; name?: string; department?: string; designation?: string; roleEmail?: string; shortForm?: string } | undefined;
        if (!allow.exists() || a?.role !== 'faculty') {
          if (!cancelled) setNotListed(true);
          return;
        }
        const name = (user.displayName || a?.name || email.split('@')[0]).trim();
        await setDoc(doc(db, 'users', user.uid), {
          uid: user.uid,
          name,
          email,
          role: 'faculty',
          ...(a?.department ? { department: a.department } : {}),
          ...(a?.designation ? { designation: a.designation } : {}),
          ...(a?.roleEmail ? { roleEmail: a.roleEmail } : {}),
          ...(a?.shortForm ? { shortForm: a.shortForm } : {}),
        });
        if (!cancelled) onReady(name);
      } catch (e: any) {
        if (cancelled) return;
        const msg = String(e?.message ?? '');
        setError(
          /offline|network|unavailable/i.test(msg)
            ? 'No internet connection. Check your connection and reload the page.'
            : /permission/i.test(msg)
              ? `Your account could not be set up. Make sure you signed in with your ${COLLEGE_EMAIL_DOMAIN} email and that it is verified.`
              : 'Something went wrong while setting up your account. Reload the page to try again.',
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [stage, email, user, onReady]);

  const checkVerified = async () => {
    setBusy(true);
    setError('');
    setInfo('');
    try {
      await user.reload();
      if (auth.currentUser?.emailVerified) {
        await auth.currentUser.getIdToken(true);
        setStage('create');
      } else {
        setError('Not verified yet. Open the link in the email we sent, then press this button again.');
      }
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    setBusy(true);
    setError('');
    setInfo('');
    try {
      await sendEmailVerification(user);
      setInfo(`Sent again to ${email}. Check spam too.`);
    } catch {
      setError('Please wait a minute before asking for another email.');
    } finally {
      setBusy(false);
    }
  };

  const card = (children: React.ReactNode) => (
    <div className="status-shell">
      <div className="card" style={{ width: 440, maxWidth: '100%', padding: '2.25rem' }}>
        {children}
      </div>
    </div>
  );

  if (stage === 'verify') {
    return card(
      <>
        <p className="eyebrow" style={{ margin: 0 }}>One more step</p>
        <h2 style={{ fontSize: '1.4rem', margin: '0.3rem 0 0.6rem' }}>Verify your email</h2>
        <p style={{ margin: 0, color: 'var(--ink-soft)' }}>
          We sent a link to <strong>{email}</strong>. Open it, then come back here.
        </p>
        {error && <div className="notice notice-error" role="alert">{error}</div>}
        {info && <div className="notice notice-ok" role="status">{info}</div>}
        <button type="button" onClick={checkVerified} disabled={busy} style={{ width: '100%', marginTop: '1.4rem', padding: '0.8rem' }}>
          {busy ? 'Checking…' : "I've verified my email"}
        </button>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '1rem' }}>
          <button type="button" className="button-secondary" onClick={resend} disabled={busy}>Resend email</button>
          <button type="button" className="button-secondary" onClick={() => signOut(auth)}>Use another account</button>
        </div>
      </>,
    );
  }

  if (notListed) {
    return card(
      <>
        <h2 style={{ fontSize: '1.3rem', margin: '0 0 0.5rem' }}>Not on the faculty list yet</h2>
        <p style={{ margin: 0, color: 'var(--ink-soft)' }}>
          <strong>{email}</strong> isn't on the approved faculty list, so this account can't open the portal. If you're a
          faculty member, ask the admin to add your email. Students use the CollegeGo app instead.
        </p>
        <div style={{ display: 'flex', gap: '0.6rem', marginTop: '1.4rem', flexWrap: 'wrap' }}>
          <a
            className="button-secondary"
            style={{ padding: '0.6rem 1rem', borderRadius: 12, textDecoration: 'none' }}
            href={`mailto:${SUPPORT.email}?subject=${encodeURIComponent('Faculty portal: please add my email')}&body=${encodeURIComponent(`Please add ${email} to the faculty list.`)}`}
          >
            Email the admin
          </a>
          <button type="button" onClick={() => signOut(auth)}>Sign out</button>
        </div>
      </>,
    );
  }

  return card(
    <>
      <BrandLoader label="Setting up your faculty account…" />
      {error && <div className="notice notice-error" role="alert">{error}</div>}
      {error && (
        <button type="button" className="button-secondary" onClick={() => signOut(auth)} style={{ marginTop: '1rem' }}>
          Sign out
        </button>
      )}
    </>,
  );
}
