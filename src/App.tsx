import { useState, useEffect } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import type { User } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from './firebaseConfig';
import Header from './Header';
import Login from './Login';
import SegmentedControl from './SegmentedControl';
import Upload from './Upload';
import RosterUpload from './RosterUpload';
import RosterBrowser from './RosterBrowser';
import CurriculumUpload from './CurriculumUpload';
import CurriculumBrowser from './CurriculumBrowser';
import TimetableEditor from './TimetableEditor';
import MessSubscribersUpload from './MessSubscribersUpload';
import AttendanceUpload from './AttendanceUpload';
import AssignGrades from './AssignGrades';
import MarkAttendance from './MarkAttendance';

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [checkingAuth, setCheckingAuth] = useState(true);
  // This MUST be declared here, alongside the other hooks — not after an
  // early return — since React requires every hook to run in the same
  // order on every single render, no exceptions.
  const [activeTab, setActiveTab] = useState<'resources' | 'roster' | 'curriculum' | 'timetable' | 'messSubscribers' | 'attendance' | 'grades'>('resources');
  // Roster and Curriculum each have their own Upload/Browse sub-tab —
  // bulk-file a whole spreadsheet, or search/fix/remove individual
  // entries without needing one.
  const [rosterMode, setRosterMode] = useState<'upload' | 'browse'>('upload');
  const [curriculumMode, setCurriculumMode] = useState<'upload' | 'browse'>('upload');
  const [attendanceMode, setAttendanceMode] = useState<'mark' | 'excel'>('mark');

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
    return (
      <>
        <Header user={null} />
        <div className="status-shell">
          <div className="loading-stamp" aria-hidden="true" />
          <p className="eyebrow" style={{ margin: 0 }}>Loading…</p>
        </div>
      </>
    );
  }

  if (!user) {
    return <Login />;
  }

  if (role !== 'faculty') {
    return (
      <>
        <Header user={user} />
        <div className="status-shell">
          <div className="card" style={{ width: 360, maxWidth: '100%', padding: '2.5rem', textAlign: 'center' }}>
            <p className="eyebrow">Access denied</p>
            <p style={{ marginTop: '1rem' }}>This portal is for faculty accounts only.</p>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <Header user={user} />
      <div className="app-body">
        <div className="tab-bar">
          <SegmentedControl
            options={[
              { value: 'resources', label: 'Resources' },
              { value: 'roster', label: 'Roster' },
              { value: 'curriculum', label: 'Curriculum' },
              { value: 'timetable', label: 'Timetable' },
              { value: 'messSubscribers', label: 'Thali Subscribers' },
              { value: 'attendance', label: 'Attendance' },
              { value: 'grades', label: 'Assign Grades' },
            ]}
            value={activeTab}
            onChange={setActiveTab}
          />
        </div>

        {activeTab === 'resources' && (
          <div className="panel-enter" key="resources">
            <Upload />
          </div>
        )}

        {activeTab === 'roster' && (
          <div className="panel-enter" key={`roster-${rosterMode}`}>
            <div className="subtab-bar">
              <SegmentedControl
                size="sm"
                options={[
                  { value: 'upload', label: 'Bulk Upload' },
                  { value: 'browse', label: 'Browse & Edit' },
                ]}
                value={rosterMode}
                onChange={setRosterMode}
              />
            </div>
            {rosterMode === 'upload' ? <RosterUpload /> : <RosterBrowser />}
          </div>
        )}

        {activeTab === 'curriculum' && (
          <div className="panel-enter" key={`curriculum-${curriculumMode}`}>
            <div className="subtab-bar">
              <SegmentedControl
                size="sm"
                options={[
                  { value: 'upload', label: 'Bulk Upload' },
                  { value: 'browse', label: 'Browse & Edit' },
                ]}
                value={curriculumMode}
                onChange={setCurriculumMode}
              />
            </div>
            {curriculumMode === 'upload' ? <CurriculumUpload /> : <CurriculumBrowser />}
          </div>
        )}

        {activeTab === 'timetable' && (
          <div className="panel-enter" key="timetable">
            <TimetableEditor />
          </div>
        )}

        {activeTab === 'messSubscribers' && (
          <div className="panel-enter" key="messSubscribers">
            <MessSubscribersUpload />
          </div>
        )}

        {activeTab === 'attendance' && (
          <div className="panel-enter" key={`attendance-${attendanceMode}`}>
            <div className="subtab-bar">
              <SegmentedControl
                size="sm"
                options={[
                  { value: 'mark', label: 'Mark Directly' },
                  { value: 'excel', label: 'Upload Excel Register' },
                ]}
                value={attendanceMode}
                onChange={setAttendanceMode}
              />
            </div>
            {attendanceMode === 'mark' ? <MarkAttendance /> : <AttendanceUpload />}
          </div>
        )}

        {activeTab === 'grades' && (
          <div className="panel-enter" key="grades">
            <AssignGrades />
          </div>
        )}
      </div>
    </>
  );
}

export default App;
