import { SUPPORT } from './support';
import { useState } from 'react';
import { signInWithEmailAndPassword, sendPasswordResetEmail } from 'firebase/auth';
import { auth } from './firebaseConfig';
import { Icon, type IconName } from './icons';

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

function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [loading, setLoading] = useState(false);
  const [resetting, setResetting] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setInfo('');
    setLoading(true);
    try {
      await signInWithEmailAndPassword(auth, email.trim(), password);
    } catch (err: any) {
      setError('Wrong email or password.');
      console.error('Login error:', err.code);
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
      await sendPasswordResetEmail(auth, email.trim());
      setInfo(`Reset link sent to ${email.trim()}. Check your inbox.`);
    } catch (err: any) {

      setError('Could not send a reset link. Check the email address and try again.');
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
            <span className="brand-sub">× IIIT Surat</span>
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
              <span className="brand-sub">× IIIT Surat</span>
            </div>
          </div>

          <p className="eyebrow" style={{ margin: 0 }}>Faculty portal</p>
          <h1>Sign in</h1>
          <p className="login-lead">Use your institute email.</p>

          <form onSubmit={handleLogin}>
            <label htmlFor="login-email">Email</label>
            <input
              id="login-email"
              type="email"
              autoComplete="username"
              placeholder="name@iiitsurat.ac.in"
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
          </form>

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
