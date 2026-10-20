import BrandLoader from './BrandLoader';
import HelpButton from './HelpButton';
import { useState, useEffect, useCallback, Suspense } from 'react';
import { lazyRetry } from './lazyRetry';
import { onAuthStateChanged } from 'firebase/auth';
import type { User } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from './firebaseConfig';
import Header from './Header';
import Login from './Login';
import SegmentedControl from './SegmentedControl';
import Sidebar, { initialsOf, type Profile } from './Sidebar';
import Home from './Home';
import { Icon } from './icons';
import { NAV, findTab, toneVars, type Tab } from './nav';
import { useMedicalWaiting } from './useMedicalWaiting';
import { useActiveSos } from './useActiveSos';
// Every tab below is loaded lazily, on first visit to that tab — not all
// upfront. Several of these pull in genuinely heavy libraries (xlsx,
// pdfjs-dist) that were previously bundled into the one JS file the
// whole app has to download before it can render anything, even for a
// faculty member who only ever uses Resources. Splitting per tab means
// the initial load only pays for Login/Header/the tab bar/Resources.
const Upload = lazyRetry(() => import('./Upload'));
const RosterUpload = lazyRetry(() => import('./RosterUpload'));
const RosterBrowser = lazyRetry(() => import('./RosterBrowser'));
const CurriculumUpload = lazyRetry(() => import('./CurriculumUpload'));
const CurriculumBrowser = lazyRetry(() => import('./CurriculumBrowser'));
const TimetableEditor = lazyRetry(() => import('./TimetableEditor'));
const RoomCleanup = lazyRetry(() => import('./RoomCleanup'));
const MyTimetable = lazyRetry(() => import('./MyTimetable'));
const ExamSchedule = lazyRetry(() => import('./ExamSchedule'));
const AddHoliday = lazyRetry(() => import('./AddHoliday'));
const MessSubscribersUpload = lazyRetry(() => import('./MessSubscribersUpload'));
const AttendanceUpload = lazyRetry(() => import('./AttendanceUpload'));
const AssignGrades = lazyRetry(() => import('./AssignGrades'));
const ClassCGPA = lazyRetry(() => import('./ClassCGPA'));
const MarkAttendance = lazyRetry(() => import('./MarkAttendance'));
const AttendanceExport = lazyRetry(() => import('./AttendanceExport'));
const AttendanceRegister = lazyRetry(() => import('./AttendanceRegister'));
const InboxImports = lazyRetry(() => import('./InboxImports'));
const Announcements = lazyRetry(() => import('./Announcements'));
const Complaints = lazyRetry(() => import('./Complaints'));
const Reports = lazyRetry(() => import('./Reports'));
const MedicalLeaves = lazyRetry(() => import('./MedicalLeaves'));
const SosBoard = lazyRetry(() => import('./SosBoard'));

// Shown for the brief moment a tab's own code is downloading — only ever
// visible on that tab's first visit in a session, since the browser
// caches the chunk after that.
function TabLoading() {
  return (
    <div style={{ padding: '4rem 0' }}>
      <BrandLoader />
    </div>
  );
}

// The page lives in the URL hash (#attendance), so a refresh keeps you
// where you were and the browser's Back button moves between pages.
const ALL_TABS = new Set<Tab>(['home', ...NAV.flatMap((g) => g.items.map((i) => i.tab))]);
const tabFromHash = (): Tab => {
  const h = window.location.hash.replace(/^#\/?/, '') as Tab;
  return ALL_TABS.has(h) ? h : 'home';
};

// Warm the most-used pages' code shortly after first paint, so the first
// click on them is instant (the other groups warm on hover).
const prefetchPrimary = () => {
  import('./Upload');
  import('./MedicalLeaves');
  import('./MarkAttendance');
  import('./Announcements');
};

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [activeTab, setActiveTabState] = useState<Tab>(tabFromHash);
  const [menuOpen, setMenuOpen] = useState(false);
  const [rosterMode, setRosterMode] = useState<'upload' | 'browse'>('upload');
  const [curriculumMode, setCurriculumMode] = useState<'upload' | 'browse'>('upload');
  const [attendanceMode, setAttendanceMode] = useState<'mark' | 'register' | 'excel' | 'export'>('mark');

  const medicalWaiting = useMedicalWaiting(role === 'faculty' || role === 'admin' ? profile?.email ?? null : null);
  // Live SOS alerts — null for anyone who isn't a responder/admin.
  const sosAlerts = useActiveSos(role === 'faculty' || role === 'admin');
  const sosOpen = sosAlerts?.filter((a) => a.status === 'open').length ?? 0;
  useEffect(() => {
    const base = 'IIIT Surat · Faculty Desk';
    document.title = sosOpen > 0 ? `(${sosOpen}) SOS · ${base}` : base;
  }, [sosOpen]);

  const openTab = useCallback((tab: Tab) => {
    setMenuOpen(false);
    setActiveTabState(tab);
    if (tabFromHash() !== tab) window.history.pushState(null, '', tab === 'home' ? '#' : `#${tab}`);
    window.scrollTo({ top: 0 });
  }, []);
  const closeMenu = useCallback(() => setMenuOpen(false), []);

  useEffect(() => {
    const onPop = () => setActiveTabState(tabFromHash());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Fire once, shortly after first paint — not immediately, so it never
  // competes with the initial page render for bandwidth/CPU.
  useEffect(() => {
    const id = setTimeout(prefetchPrimary, 1200);
    return () => clearTimeout(id);
  }, []);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      setUser(firebaseUser);

      try {
        if (firebaseUser) {
          const userDoc = await getDoc(doc(db, 'users', firebaseUser.uid));
          const data = userDoc.exists()
            ? (userDoc.data() as { role?: string; name?: string; email?: string; isAdmin?: boolean })
            : null;
          // isAdmin (set only by scripts/make-admin.js) gives full admin
          // access on top of the account's normal role — e.g. a student
          // who runs the app keeps their student profile in the app.
          setRole(data?.isAdmin === true ? 'admin' : data?.role ?? null);
          // The medical-leave rules match on the email stored on the
          // profile, so that's the one used for the badge too.
          const email = (data?.email ?? firebaseUser.email ?? '').toLowerCase();
          setProfile({ name: data?.name?.trim() || firebaseUser.displayName || email, email });
        } else {
          setRole(null);
          setProfile(null);
        }
      } catch {
        // Offline / transient failure: treat as "no role" (shows Access
        // denied with a log-out option) instead of hanging on Loading…
        setRole(null);
      } finally {
        setCheckingAuth(false);
      }
    });

    return () => unsubscribe();
  }, []);

  if (checkingAuth) {
    return (
      <div className="status-shell">
        <BrandLoader large label="Opening Faculty Desk…" />
      </div>
    );
  }

  if (!user) {
    return <Login />;
  }

  // Admin included here too, not just faculty — every rule this portal's
  // writes go through (firestore.rules) already treats admin as a
  // superset of faculty everywhere else in the app; the portal's own
  // login gate was the one place that inconsistently excluded it.
  if (role !== 'faculty' && role !== 'admin') {
    return (
      <>
        <Header user={user} />
        <div className="status-shell">
          <div className="card" style={{ width: 380, maxWidth: '100%', padding: '2.25rem', textAlign: 'center' }}>
            <span className="group-card-icon" style={{ ...toneVars('peach'), margin: '0 auto 1rem', width: 48, height: 48, borderRadius: 15 }}>
              <Icon name="lock" size={22} />
            </span>
            <h2 style={{ fontSize: '1.25rem', margin: '0 0 0.4rem' }}>Faculty only</h2>
            <p style={{ margin: 0, color: 'var(--ink-soft)' }}>
              This portal is for faculty and admin accounts. Students can use the IIIT Surat app.
            </p>
          </div>
        </div>
      </>
    );
  }

  const me = profile ?? { name: user.email ?? 'Faculty', email: user.email ?? '' };
  const where = findTab(activeTab);
  const pageTitle = where ? where.item.label : 'Home';

  return (
    <div className={`shell${menuOpen ? ' sidebar-open' : ''}`}>
      <div className="sidebar-scrim" onClick={closeMenu} aria-hidden="true" />
      <Sidebar
        active={activeTab}
        onSelect={openTab}
        profile={me}
        medicalWaiting={medicalWaiting}
        sosCount={sosAlerts?.length ?? null}
        open={menuOpen}
        onClose={closeMenu}
      />

      <HelpButton role={role} name={me.name} email={me.email} currentPage={pageTitle} />

      <main className="main">
        {/* Phones: compact bar with the menu button; the sidebar slides in. */}
        <div className="topbar">
          <button type="button" className="icon-button" onClick={() => setMenuOpen(true)} aria-label="Open menu">
            <Icon name="menu" size={22} />
          </button>
          <span className="topbar-title">{pageTitle}</span>
          {medicalWaiting ? (
            <button
              type="button"
              className="icon-button"
              onClick={() => openTab('medicalLeaves')}
              aria-label={`${medicalWaiting} medical leave steps waiting`}
              style={{ position: 'relative' }}
            >
              <Icon name="medical" size={20} />
              <span className="nav-item-badge" style={{ position: 'absolute', top: -2, right: -4, transform: 'scale(0.85)' }}>
                {medicalWaiting}
              </span>
            </button>
          ) : null}
          <span className="avatar" aria-hidden="true">{initialsOf(me.name)}</span>
        </div>

        <div className="main-inner">
          {sosAlerts && sosAlerts.length > 0 && activeTab !== 'sos' && (
            <button type="button" className="sos-banner" onClick={() => openTab('sos')}>
              <Icon name="alert" size={22} />
              <span>
                <b>
                  {sosAlerts.length === 1
                    ? `SOS: ${sosAlerts[0].studentName}${sosAlerts[0].status === 'acknowledged' ? ' (someone is on the way)' : ''}`
                    : `${sosAlerts.length} active SOS alerts`}
                </b>
                <small>Location, phone and actions on the SOS board</small>
              </span>
              <span className="sos-banner-go">Open →</span>
            </button>
          )}

          {where && (
            <div className="crumb">
              <span className="crumb-tone" style={toneVars(where.group.tone)}>{where.group.label}</span>
              <Icon name="chevron" size={14} />
              <span>{where.item.label}</span>
            </div>
          )}

          <Suspense fallback={<TabLoading />}>
            {activeTab === 'home' && <Home name={me.name} medicalWaiting={medicalWaiting} onOpen={openTab} />}

            {activeTab === 'resources' && (
              <div className="panel-enter" key="resources">
                <Upload />
              </div>
            )}

            {activeTab === 'announcements' && (
              <div className="panel-enter" key="announcements">
                <Announcements />
              </div>
            )}

            {activeTab === 'complaints' && (
              <div className="panel-enter" key="complaints">
                <Complaints />
              </div>
            )}

            {activeTab === 'reports' && (
              <div className="panel-enter" key="reports">
                <Reports />
              </div>
            )}

            {activeTab === 'sos' && (
              <div className="panel-enter" key="sos">
                <SosBoard alerts={sosAlerts} me={{ name: me.name, email: me.email }} />
              </div>
            )}

            {activeTab === 'medicalLeaves' && (
              <div className="panel-enter" key="medicalLeaves">
                <MedicalLeaves />
              </div>
            )}

            {activeTab === 'inboxImports' && (
              <div className="panel-enter" key="inboxImports">
                <InboxImports />
              </div>
            )}

            {activeTab === 'roster' && (
              <div className="panel-enter" key="roster">
                <div className="subtab-bar" style={{ paddingTop: '0.75rem' }}>
                  <SegmentedControl<'upload' | 'browse'>
                    size="sm"
                    options={[
                      { value: 'upload', label: 'Bulk upload' },
                      { value: 'browse', label: 'Browse & edit' },
                    ]}
                    value={rosterMode}
                    onChange={setRosterMode}
                  />
                </div>
                <div className="panel-enter" key={rosterMode}>
                  {rosterMode === 'upload' ? <RosterUpload /> : <RosterBrowser />}
                </div>
              </div>
            )}

            {activeTab === 'curriculum' && (
              <div className="panel-enter" key="curriculum">
                <div className="subtab-bar" style={{ paddingTop: '0.75rem' }}>
                  <SegmentedControl<'upload' | 'browse'>
                    size="sm"
                    options={[
                      { value: 'upload', label: 'Bulk upload' },
                      { value: 'browse', label: 'Browse & edit' },
                    ]}
                    value={curriculumMode}
                    onChange={setCurriculumMode}
                  />
                </div>
                <div className="panel-enter" key={curriculumMode}>
                  {curriculumMode === 'upload' ? <CurriculumUpload /> : <CurriculumBrowser />}
                </div>
              </div>
            )}

            {activeTab === 'timetable' && (
              <div className="panel-enter" key="timetable">
                <TimetableEditor />
              </div>
            )}

            {activeTab === 'myTimetable' && (
              <div className="panel-enter" key="myTimetable">
                <MyTimetable role={role} name={me.name} />
              </div>
            )}

            {activeTab === 'roomCleanup' && (
              <div className="panel-enter" key="roomCleanup">
                <RoomCleanup />
              </div>
            )}

            {activeTab === 'exams' && (
              <div className="panel-enter" key="exams">
                <ExamSchedule />
              </div>
            )}

            {activeTab === 'holidays' && (
              <div className="panel-enter" key="holidays">
                <AddHoliday />
              </div>
            )}

            {activeTab === 'messSubscribers' && (
              <div className="panel-enter" key="messSubscribers">
                <MessSubscribersUpload />
              </div>
            )}

            {activeTab === 'attendance' && (
              <div className="panel-enter" key="attendance">
                <div className="subtab-bar" style={{ paddingTop: '0.75rem' }}>
                  <SegmentedControl<'mark' | 'register' | 'excel' | 'export'>
                    size="sm"
                    options={[
                      { value: 'mark', label: 'Mark' },
                      { value: 'register', label: 'Register' },
                      { value: 'excel', label: 'Upload' },
                      { value: 'export', label: 'Download' },
                    ]}
                    value={attendanceMode}
                    onChange={setAttendanceMode}
                  />
                </div>
                <div className="panel-enter" key={attendanceMode}>
                  {attendanceMode === 'mark' ? (
                    <MarkAttendance />
                  ) : attendanceMode === 'register' ? (
                    <AttendanceRegister />
                  ) : attendanceMode === 'excel' ? (
                    <AttendanceUpload />
                  ) : (
                    <AttendanceExport />
                  )}
                </div>
              </div>
            )}

            {activeTab === 'grades' && (
              <div className="panel-enter" key="grades">
                <AssignGrades />
              </div>
            )}

            {activeTab === 'cgpa' && (
              <div className="panel-enter" key="cgpa">
                <ClassCGPA />
              </div>
            )}
          </Suspense>
        </div>
      </main>
    </div>
  );
}

export default App;
