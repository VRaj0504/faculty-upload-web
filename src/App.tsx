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
const Notices = lazyRetry(() => import('./Notices'));
const Complaints = lazyRetry(() => import('./Complaints'));
const Reports = lazyRetry(() => import('./Reports'));
const MedicalLeaves = lazyRetry(() => import('./MedicalLeaves'));
const SosBoard = lazyRetry(() => import('./SosBoard'));

function TabLoading() {
  return (
    <div style={{ padding: '4rem 0' }}>
      <BrandLoader />
    </div>
  );
}

const ALL_TABS = new Set<Tab>(['home', ...NAV.flatMap((g) => g.items.map((i) => i.tab))]);
const tabFromHash = (): Tab => {
  const h = window.location.hash.replace(/^#\/?/, '') as Tab;
  return ALL_TABS.has(h) ? h : 'home';
};

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

  const sosAlerts = useActiveSos(role === 'faculty' || role === 'admin');
  const sosOpen = sosAlerts?.filter((a) => a.status === 'open').length ?? 0;
  useEffect(() => {
    const base = 'CollegeGo × IIIT Surat';
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

  useEffect(() => {
    const id = setTimeout(prefetchPrimary, 1200);
    return () => clearTimeout(id);
  }, []);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      setUser(firebaseUser);

      const cacheKey = firebaseUser ? `cg-portal-profile:${firebaseUser.uid}` : '';
      let cached: { role: string | null; profile: Profile } | null = null;
      if (firebaseUser) {
        try {
          cached = JSON.parse(localStorage.getItem(cacheKey) || 'null');
        } catch {
          cached = null;
        }
        if (cached) {
          setRole(cached.role);
          setProfile(cached.profile);
          setCheckingAuth(false);
        }
      }

      try {
        if (firebaseUser) {
          const userDoc = await getDoc(doc(db, 'users', firebaseUser.uid));
          const data = userDoc.exists()
            ? (userDoc.data() as { role?: string; name?: string; email?: string; isAdmin?: boolean })
            : null;

          const nextRole = data?.isAdmin === true ? 'admin' : data?.role ?? null;
          setRole(nextRole);

          const email = (data?.email ?? firebaseUser.email ?? '').toLowerCase();
          const nextProfile = { name: data?.name?.trim() || firebaseUser.displayName || email, email };
          setProfile(nextProfile);
          try {
            localStorage.setItem(cacheKey, JSON.stringify({ role: nextRole, profile: nextProfile }));
          } catch {

          }
        } else {
          setRole(null);
          setProfile(null);
          try {
            Object.keys(localStorage)
              .filter((k) => k.startsWith('cg-portal-profile:'))
              .forEach((k) => localStorage.removeItem(k));
          } catch {

          }
        }
      } catch {

        if (!cached) setRole(null);
      } finally {
        setCheckingAuth(false);
      }
    });

    return () => unsubscribe();
  }, []);

  if (checkingAuth) {
    return (
      <div className="status-shell">
        <BrandLoader large label="Opening CollegeGo…" />
      </div>
    );
  }

  if (!user) {
    return <Login />;
  }

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

            {activeTab === 'notices' && (
              <div className="panel-enter" key="notices">
                <Notices />
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
