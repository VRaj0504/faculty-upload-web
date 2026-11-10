import { SUPPORT } from './support';
import { useState } from 'react';
import {
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  createUserWithEmailAndPassword,
  sendEmailVerification,
  updateProfile,
  signInWithPopup,
  GoogleAuthProvider,
  signOut,
} from 'firebase/auth';
import { auth, functions } from './firebaseConfig';
import { httpsCallable } from 'firebase/functions';
import { Icon, type IconName } from './icons';
import { COLLEGE_EMAIL_DOMAIN } from './college';

const PREVIEW: { title: string; sub: string; icon: IconName; bg: string; fg: string }[] = [
  { title: 'Resources', sub: 'Notes, papers & slides', icon: 'upload', bg: 'var(--tone-blue-bg)', fg: 'var(--tone-blue-fg)' },
  { title: 'Medical leaves', sub: 'Doctor → HOD → you', icon: 'medical', bg: 'var(--tone-lilac-bg)', fg: 'var(--tone-lilac-fg)' },
  { title: 'Attendance', sub: 'Mark or upload', icon: 'check', bg: 'var(--tone-mint-bg)', fg: 'var(--tone-mint-fg)' },
];

const MARKS = [
  { x: '6%', y: '10%', s: 64, d: 16, delay: 0 },
  { x: '70%', y: '6%', s: 44, d: 19, delay: -5 },
  { x: '38%', y: '30%', s: 84, d: 22, delay: -9 },
  { x: '84%', y: '40%', s: 56, d: 17, delay: -3 },
  { x: '12%', y: '56%', s: 48, d: 20, delay: -12 },
  { x: '58%', y: '66%', s: 70, d: 24, delay: -7 },
  { x: '88%', y: '84%', s: 40, d: 18, delay: -14 },
  { x: '24%', y: '86%', s: 58, d: 21, delay: -2 },
];

function LoginBg({ tone }: { tone: 'dark' | 'light' }) {
  return (
    <div className={`login-bg login-bg-${tone}`} aria-hidden="true">
      <span className="login-glow lg1" />
      <span className="login-glow lg2" />
      {MARKS.map((m, i) => (
        <span
          key={i}
          className="login-mark"
          style={{ left: m.x, top: m.y, width: m.s, height: m.s, fontSize: m.s * 0.38, animationDuration: `${m.d}s`, animationDelay: `${m.delay}s` }}
        >

          <svg viewBox="150 180 724 664" width="56%" height="56%" fill="none" stroke="currentColor" strokeWidth="96" strokeLinecap="round" strokeLinejoin="round">
            <path d="M 671.8 344.7 A 250 250 0 1 0 653.3 697.8" />
            <path d="M 606 512 H 784 V 668" />
            <circle cx="784" cy="690" r="52" fill="currentColor" stroke="none" />
          </svg>
        </span>
      ))}
    </div>
  );
}

const DOMAIN = COLLEGE_EMAIL_DOMAIN;
const isInstitute = (e: string) => e.trim().toLowerCase().endsWith(DOMAIN);

function friendly(code: string): string {
  switch (code) {
    case 'auth/email-already-in-use':
      return 'An account with this email already exists. Sign in instead, or use "Forgot password?".';
    case 'auth/weak-password':
      return 'Use a password with at least 8 characters.';
    case 'auth/invalid-email':
      return 'That email address looks wrong.';
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
      return '';
    case 'auth/popup-blocked':
      return 'Your browser blocked the Google window. Allow pop-ups for this site and try again.';
    case 'auth/network-request-failed':
      return 'No internet connection. Check your connection and try again.';
    case 'auth/too-many-requests':
    case 'auth/quota-exceeded':
      return 'Too many attempts from this network. Wait a few minutes, or use "Continue with Google".';
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'Wrong email or password.';
    case 'auth/user-disabled':
      return 'This account has been disabled. Contact the admin.';
    case 'auth/internal-error':
      return 'The sign-in service is busy. Try again in a moment.';
    default:
      return 'Something went wrong. Please try again.';
  }
}

const TRANSIENT = new Set(['functions/unavailable', 'functions/deadline-exceeded', 'functions/internal', 'auth/network-request-failed', 'auth/internal-error']);
async function withRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e: any) {
      if (!TRANSIENT.has(e?.code) || i >= tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 600 * 2 ** i + Math.random() * 600));
    }
  }
}

function Login() {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [name, setName] = useState('');
  const [confirm, setConfirm] = useState('');
  const [googleBusy, setGoogleBusy] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(() => {
    try {
      const n = sessionStorage.getItem('cg-portal-notice') ?? '';
      if (n) sessionStorage.removeItem('cg-portal-notice');
      return n;
    } catch {
      return '';
    }
  });
  const [info, setInfo] = useState('');
  const [loading, setLoading] = useState(false);
  const [resetting, setResetting] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setInfo('');
    setLoading(true);
    try {
      await withRetry(() => signInWithEmailAndPassword(auth, email.trim(), password));
    } catch (err: any) {
      setError(friendly(err?.code ?? ''));
      console.error('Login error:', err.code);
    } finally {
      setLoading(false);
    }
  };

  const handleGoogle = async () => {
    setError('');
    setInfo('');
    setGoogleBusy(true);
    try {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ hd: DOMAIN.slice(1), prompt: 'select_account' });
      const res = await signInWithPopup(auth, provider);
      const got = (res.user.email ?? '').toLowerCase();
      if (!isInstitute(got)) {
        await signOut(auth);
        setError(`${got || 'That account'} isn't an institute account. Choose your ${DOMAIN} Google account.`);
      }
    } catch (err: any) {
      const msg = friendly(err?.code ?? '');
      if (msg) setError(msg);
    } finally {
      setGoogleBusy(false);
    }
  };

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setInfo('');
    const em = email.trim().toLowerCase();
    if (!name.trim()) return setError('Enter your full name.');
    if (!isInstitute(em)) return setError(`Use your institute email (${DOMAIN}).`);
    if (password.length < 8) return setError('Use a password with at least 8 characters.');
    if (password !== confirm) return setError("The two passwords don't match.");
    setLoading(true);
    try {
      let created = false;
      try {
        await withRetry(() => httpsCallable(functions, 'createAccount')({ name: name.trim(), email: em, password, audience: 'faculty' }));
        created = true;
      } catch (e: any) {
        if (e?.code === 'functions/already-exists') throw { code: 'auth/email-already-in-use' };
        if (e?.code === 'functions/failed-precondition' || e?.code === 'functions/invalid-argument') throw { code: 'server', message: e.message };
        if (e?.code !== 'functions/not-found' && e?.code !== 'functions/unimplemented' && !TRANSIENT.has(e?.code)) throw e;
      }
      if (created) {
        await withRetry(() => signInWithEmailAndPassword(auth, em, password));
      } else {
        const cred = await createUserWithEmailAndPassword(auth, em, password);
        await updateProfile(cred.user, { displayName: name.trim() }).catch(() => undefined);
      }
      if (auth.currentUser) await withRetry(() => sendEmailVerification(auth.currentUser!)).catch(() => undefined);
    } catch (err: any) {
      setError(err?.code === 'server' ? err.message : friendly(err?.code ?? ''));
    } finally {
      setLoading(false);
    }
  };

  const handleForgotPassword = async () => {
    if (resetting) return;
    setError('');
    setInfo('');
    if (!email.trim()) {
      setError('Type your email first, then tap "Forgot password?".');
      return;
    }
    setResetting(true);
    try {
      await withRetry(() => sendPasswordResetEmail(auth, email.trim()));
      setInfo(`Reset link sent to ${email.trim()}. Check your inbox.`);
    } catch (err: any) {
      setError(
        err?.code === 'auth/too-many-requests'
          ? 'A reset link was sent recently. Check your inbox (and spam), or try again in a few minutes.'
          : err?.code === 'auth/network-request-failed'
            ? 'No internet connection. Check your connection and try again.'
            : 'Could not send a reset link. Check the email address and try again.',
      );
      console.error('Password reset error:', err.code);
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="login-shell">
      <section className="login-hero" aria-hidden="true">
        <LoginBg tone="dark" />
        <div className="login-hero-brand">
          <img className="brand-logo" src="/logo.svg" alt="" />
          <div className="brand-text">
            <img className="brand-word" src="/wordmark-light.png" alt="CollegeGo" />
            <span className="brand-sub">Faculty</span>
          </div>
        </div>

        <div>
          <h1 className="login-hero-title">
            Everything for your
            <br />
            classes, in one desk.
          </h1>
          <p className="login-hero-copy">
            File resources, mark attendance, sign off medical leaves and keep timetables current. Students see it
            in the app straight away.
          </p>
        </div>

        <div className="login-mosaic">
          {PREVIEW.map((p) => (
            <div key={p.title} style={{ background: p.bg, color: p.fg }}>
              <span className="tile-icon">
                <Icon name={p.icon} size={18} />
              </span>
              <span>
                <b>{p.title}</b>
                <br />
                <small>{p.sub}</small>
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="login-form-side">
        <LoginBg tone="light" />
        <div className="login-card">
          <div className="login-mobile-brand">
            <img className="brand-logo" src="/logo.svg" alt="" aria-hidden="true" />
            <div className="brand-text">
              <img className="brand-word" src="/wordmark.png" alt="CollegeGo" />
              <span className="brand-sub">Faculty</span>
            </div>
          </div>

          <p className="eyebrow" style={{ margin: 0 }}>Faculty portal</p>
          <h1>{mode === 'signin' ? 'Sign in' : 'Create account'}</h1>
          <p className="login-lead">
            {mode === 'signin' ? 'Use your institute email.' : 'For faculty on the approved list. Use your institute email.'}
          </p>

          <button type="button" className="google-btn" onClick={handleGoogle} disabled={googleBusy || loading}>
            <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
              <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
              <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
              <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2c-2 1.5-4.5 2.4-7.2 2.4-5.3 0-9.7-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
              <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 38.4 44 33 44 24c0-1.3-.1-2.4-.4-3.5z" />
            </svg>
            {googleBusy ? 'Opening Google…' : 'Continue with Google'}
          </button>
          <div className="login-or"><span>or with email</span></div>

          {mode === 'signup' ? (
          <form onSubmit={handleSignup}>
            <label htmlFor="signup-name">Full name</label>
            <input id="signup-name" autoComplete="name" placeholder="Dr. Firstname Lastname" value={name} onChange={(e) => setName(e.target.value)} required />
            <label htmlFor="signup-email" style={{ marginTop: '1rem' }}>Institute email</label>
            <input id="signup-email" type="email" autoComplete="username" placeholder={`name${DOMAIN}`} value={email} onChange={(e) => setEmail(e.target.value)} required />
            <label htmlFor="signup-password" style={{ marginTop: '1rem' }}>Password</label>
            <input id="signup-password" type="password" autoComplete="new-password" placeholder="At least 8 characters" value={password} onChange={(e) => setPassword(e.target.value)} required />
            <label htmlFor="signup-confirm" style={{ marginTop: '1rem' }}>Confirm password</label>
            <input id="signup-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
            {error && (
              <div className="notice notice-error" role="alert">
                {error}
              </div>
            )}
            <button type="submit" disabled={loading} style={{ width: '100%', marginTop: '1.4rem', padding: '0.8rem 1.2rem' }}>
              {loading ? 'Creating account…' : 'Create account'}
            </button>
            <p className="login-foot" style={{ marginTop: '1rem' }}>
              Already have an account?{' '}
              <button type="button" className="link-button" onClick={() => { setMode('signin'); setError(''); setInfo(''); }}>
                Sign in
              </button>
            </p>
          </form>
          ) : (
          <form onSubmit={handleLogin}>
            <label htmlFor="login-email">Email</label>
            <input
              id="login-email"
              type="email"
              autoComplete="username"
              placeholder={`name${DOMAIN}`}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: '1rem' }}>
              <label htmlFor="login-password" style={{ margin: 0 }}>Password</label>
              <span
                role="button"
                tabIndex={0}
                className="link-button"
                aria-disabled={resetting}
                onClick={handleForgotPassword}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), handleForgotPassword())}
              >
                {resetting ? 'Sending…' : 'Forgot password?'}
              </span>
            </div>
            <input
              id="login-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              style={{ marginTop: '0.35rem' }}
            />

            {error && (
              <div className="notice notice-error" role="alert">
                {error}
              </div>
            )}
            {info && (
              <div className="notice notice-ok" role="status">
                {info}
              </div>
            )}

            <button type="submit" disabled={loading} style={{ width: '100%', marginTop: '1.4rem', padding: '0.8rem 1.2rem' }}>
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
            <p className="login-foot" style={{ marginTop: '1rem' }}>
              New here?{' '}
              <button type="button" className="link-button" onClick={() => { setMode('signup'); setError(''); setInfo(''); }}>
                Create an account
              </button>
            </p>
          </form>
          )}

          <p className="login-foot">For faculty and admin accounts. Students use the CollegeGo app.</p>
          <p className="login-foot" style={{ marginTop: '0.4rem' }}>
            Trouble signing in?{' '}
            <a href={`mailto:${SUPPORT.email}?subject=${encodeURIComponent('Faculty portal: trouble signing in')}`}>Contact support</a>
            {SUPPORT.phone && (
              <>
                {' '}·{' '}
                <a
                  href={`https://wa.me/${SUPPORT.phone}?text=${encodeURIComponent('Faculty portal: I have trouble signing in.')}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  WhatsApp
                </a>
              </>
            )}
          </p>
        </div>
      </section>
    </div>
  );
}

export default Login;
