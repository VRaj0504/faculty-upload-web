import { useState } from 'react';
import { signInWithEmailAndPassword } from 'firebase/auth';
import { auth } from './firebaseConfig';

function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
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

  return (
    <div className="card" style={{ width: 360, padding: '2.5rem', margin: '4rem auto' }}>
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

        <button type="submit" disabled={loading} style={{ width: '100%', marginTop: '1.5rem' }}>
          {loading ? 'Logging in...' : 'Log in'}
        </button>
      </form>
    </div>
  );
}

export default Login;