import { useState } from 'react';
import { signInWithEmailAndPassword, sendPasswordResetEmail } from 'firebase/auth';
import { auth } from './firebaseConfig';
import Header from './Header';

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
      await signInWithEmailAndPassword(auth, email, password);
    } catch (err: any) {
      setError('Invalid email or password.');
      console.error('Login error:', err.code);
    } finally {
      setLoading(false);
    }
  };

  const handleForgotPassword = async () => {
    setError('');
    setInfo('');
    if (!email.trim()) {
      setError('Enter your email above first, then click "Forgot password?".');
      return;
    }
    setResetting(true);
    try {
      await sendPasswordResetEmail(auth, email.trim());
      setInfo(`Password reset link sent to ${email.trim()} — check your inbox.`);
    } catch (err: any) {
      // Firebase deliberately doesn't distinguish "no account" from
      // "email failed to send" in the error code for this call (so a
      // stranger can't use this form to probe which emails have
      // accounts) — a generic message is the honest one to show here.
      setError('Could not send a reset link. Double check the email address and try again.');
      console.error('Password reset error:', err.code);
    } finally {
      setResetting(false);
    }
  };

  return (
    <>
      <Header user={null} />
      <div className="login-shell">
        <div className="login-hero card">
          <span className="login-hero-mark" aria-hidden="true">IS</span>
          <p className="eyebrow">IIIT Surat · Faculty Portal</p>
          <h1 className="login-hero-title">Resources Desk</h1>
          <p className="login-hero-copy">
            File notes, question papers, and slides. Keep the roster and
            curriculum current — everything faculty need to run the desk,
            in one place.
          </p>
        </div>

        <div className="login-form-side">
          <div className="card" style={{ width: 360, maxWidth: '100%', padding: '2.5rem' }}>
            <p className="eyebrow">IIIT Surat · Faculty Portal</p>
            <h1 style={{ fontSize: '1.5rem' }}>Log in</h1>

            <form onSubmit={handleLogin}>
              <div style={{ marginTop: '1.5rem' }}>
                <label>Email</label>
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
              </div>

              <div style={{ marginTop: '1rem' }}>
                <label>Password</label>
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
              </div>

              {error && <p className="error-text" style={{ marginTop: '0.8rem' }}>{error}</p>}
              {info && <p className="success-text" style={{ marginTop: '0.8rem' }}>{info}</p>}

              <button type="submit" disabled={loading} style={{ width: '100%', marginTop: '1.5rem' }}>
                {loading ? 'Logging in...' : 'Log in'}
              </button>

              <button
                type="button"
                className="button-secondary"
                onClick={handleForgotPassword}
                disabled={resetting}
                style={{ width: '100%', marginTop: '0.6rem' }}
              >
                {resetting ? 'Sending…' : 'Forgot password?'}
              </button>
            </form>
          </div>
        </div>
      </div>
    </>
  );
}

export default Login;
