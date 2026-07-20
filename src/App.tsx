import { useState, useEffect } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import type { User } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from './firebaseConfig';
import Login from './Login';
import Upload from './Upload';
import RosterUpload from './RosterUpload';
import CurriculumUpload from './CurriculumUpload';

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [checkingAuth, setCheckingAuth] = useState(true);
  // This MUST be declared here, alongside the other hooks — not after an
  // early return — since React requires every hook to run in the same
  // order on every single render, no exceptions.
  const [activeTab, setActiveTab] = useState<'resources' | 'roster' | 'curriculum'>('resources');

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      setUser(firebaseUser);

      if (firebaseUser) {
        const userDoc = await getDoc(doc(db, 'users', firebaseUser.uid));
        setRole(userDoc.exists() ? userDoc.data().role : null);
      } else {
        setRole(null);
      }

      setCheckingAuth(false);
    });

    return () => unsubscribe();
  }, []);

  if (checkingAuth) {
  return <div className="card" style={{ width: 240, padding: '2rem', margin: '4rem auto', textAlign: 'center' }}><p className="eyebrow" style={{ margin: 0 }}>Loading...</p></div>;
}

  if (!user) {
    return <Login />;
  }

  if (role !== 'faculty') {
  return (
    <div className="card" style={{ width: 360, padding: '2.5rem', margin: '4rem auto', textAlign: 'center' }}>
      <p className="eyebrow">Access denied</p>
      <p style={{ marginTop: '1rem' }}>This portal is for faculty accounts only.</p>
      <button onClick={() => auth.signOut()} style={{ marginTop: '1rem' }}>Sign out</button>
    </div>
  );
}

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'center', gap: '1rem', padding: '1rem 0' }}>
        <button className={activeTab === 'resources' ? 'button-active' : 'button-secondary'} onClick={() => setActiveTab('resources')}>Resources</button>
<button className={activeTab === 'roster' ? 'button-active' : 'button-secondary'} onClick={() => setActiveTab('roster')}>Roster</button>
        <button className={activeTab === 'curriculum' ? 'button-active' : 'button-secondary'} onClick={() => setActiveTab('curriculum')}>Curriculum</button>
      </div>
      {activeTab === 'resources' && <Upload />}
      {activeTab === 'roster' && <RosterUpload />}
      {activeTab === 'curriculum' && <CurriculumUpload />}
    </div>
  );
}

export default App;