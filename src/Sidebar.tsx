import { useEffect, useRef, type CSSProperties } from 'react';
import { auth } from './firebaseConfig';
import { Icon } from './icons';
import { NAV, toneVars, type Tab } from './nav';

export type Profile = { name: string; email: string };

export const initialsOf = (name: string) =>
  name
    .replace(/^(dr|prof|mr|ms|mrs)\.?\s+/i, '')
    .split(/[\s.@_]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || '?';

export default function Sidebar({
  active,
  onSelect,
  profile,
  medicalWaiting,
  sosCount = null,
  open,
  onClose,
}: {
  active: Tab;
  onSelect: (tab: Tab) => void;
  profile: Profile;
  medicalWaiting: number | null;
  sosCount?: number | null;
  open: boolean;
  onClose: () => void;
}) {
  const navRef = useRef<HTMLElement>(null);

  // Phone: Escape closes the slide-in menu, and focus moves into it when
  // it opens so keyboard users aren't left behind the scrim.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    navRef.current?.querySelector<HTMLButtonElement>('.nav-item-active, .nav-item')?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const item = (tab: Tab, label: string, icon: Parameters<typeof Icon>[0]['name'], tone: CSSProperties, badge?: number | null) => {
    const isActive = active === tab;
    return (
      <button
        key={tab}
        type="button"
        className={`nav-item${isActive ? ' nav-item-active' : ''}`}
        aria-current={isActive ? 'page' : undefined}
        onClick={() => onSelect(tab)}
      >
        <span className="nav-item-icon" style={tone}>
          <Icon name={icon} size={16} />
        </span>
        <span className="nav-item-label">{label}</span>
        {badge ? <span className="nav-item-badge" aria-label={`${badge} waiting`}>{badge}</span> : null}
      </button>
    );
  };

  return (
    <aside className="sidebar" aria-label="Portal navigation">
      <div className="sidebar-brand">
        <img className="brand-logo" src="/logo.svg" alt="" aria-hidden="true" />
        <div className="brand-text">
          <img className="brand-word" src="/wordmark.png" alt="CollegeGo" />
          <span className="brand-sub">× IIIT Surat</span>
        </div>
      </div>

      <nav className="sidebar-nav" ref={navRef}>
        {item('home', 'Home', 'home', { background: 'var(--surface-alt)', color: 'var(--ink)' })}
        {NAV.map((group) => (
          <div className="nav-group" key={group.id} onMouseEnter={group.prefetch} onFocus={group.prefetch}>
            <div className="nav-group-label">
              <span className="nav-group-dot" style={{ background: `var(--tone-${group.tone}-fg)` }} />
              {group.label}
            </div>
            {group.items.map((i) =>
              item(i.tab, i.label, i.icon, toneVars(group.tone), i.tab === 'medicalLeaves' ? medicalWaiting : i.tab === 'sos' ? sosCount || null : null),
            )}
          </div>
        ))}
      </nav>

      <div className="sidebar-user">
        <span className="avatar" aria-hidden="true">{initialsOf(profile.name)}</span>
        <div className="sidebar-user-text">
          <div className="sidebar-user-name">{profile.name}</div>
          <div className="sidebar-user-mail">{profile.email}</div>
        </div>
        <button type="button" className="icon-button" onClick={() => auth.signOut()} title="Sign out" aria-label="Sign out">
          <Icon name="logout" size={18} />
        </button>
      </div>
    </aside>
  );
}
