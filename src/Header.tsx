import type { User } from 'firebase/auth';
import { auth } from './firebaseConfig';

function Header({ user }: { user: User | null }) {
  return (
    <header className="app-header">
      <div className="app-header-brand">
        <span className="app-header-monogram" aria-hidden="true">IS</span>
        <div className="app-header-brand-text">
          <span className="app-header-mark">IIIT Surat</span>
          <span className="app-header-tagline">Resources Desk</span>
        </div>
      </div>
      {user && (
        <div className="app-header-user">
          <span className="app-header-name">{user.email}</span>
          <button className="button-secondary" onClick={() => auth.signOut()}>
            Sign out
          </button>
        </div>
      )}
    </header>
  );
}

export default Header;
