import type { User } from 'firebase/auth';
import { auth } from './firebaseConfig';

function Header({ user }: { user: User | null }) {
  return (
    <header className="app-header">
      <div className="app-header-brand">
        <img className="brand-logo" src="/logo.svg" alt="" aria-hidden="true" />
        <div className="app-header-brand-text">
          <img className="brand-word" src="/wordmark.png" alt="CollegeGo" />
          <span className="app-header-tagline">× IIIT Surat</span>
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
