// Every page of the portal, grouped the same way the app's Home groups
// features — one colour per group, used in the sidebar, on the Home
// cards and in the breadcrumb, so people learn where things live.
import type { IconName } from './icons';

export type Tab =
  | 'home'
  | 'resources'
  | 'announcements'
  | 'myTimetable'
  | 'roster'
  | 'attendance'
  | 'grades'
  | 'cgpa'
  | 'medicalLeaves'
  | 'sos'
  | 'complaints'
  | 'reports'
  | 'timetable'
  | 'exams'
  | 'holidays'
  | 'roomCleanup'
  | 'curriculum'
  | 'messSubscribers'
  | 'inboxImports';

export type Tone = 'blue' | 'mint' | 'lilac' | 'yellow' | 'peach' | 'pink';

export type NavItem = { tab: Tab; label: string; hint: string; icon: IconName };
export type NavGroup = {
  id: string;
  label: string;
  hint: string;
  tone: Tone;
  icon: IconName;
  items: NavItem[];
  prefetch: () => void;
};

export const toneVars = (tone: Tone) => ({
  background: `var(--tone-${tone}-bg)`,
  color: `var(--tone-${tone}-fg)`,
});

// The dynamic imports here are the same ones App's lazy() calls use, so
// hovering a group warms its pages before the click lands.
export const NAV: NavGroup[] = [
  {
    id: 'teaching',
    label: 'Teaching',
    hint: 'Files and notices for your classes',
    tone: 'blue',
    icon: 'upload',
    items: [
      { tab: 'resources', label: 'Resources', hint: 'Notes, papers & slides', icon: 'upload' },
      { tab: 'announcements', label: 'Announcements', hint: 'Notify a class', icon: 'megaphone' },
      { tab: 'myTimetable', label: 'My timetable', hint: 'Your week', icon: 'clock' },
    ],
    prefetch: () => {
      import('./Upload');
      import('./Announcements');
      import('./MyTimetable');
    },
  },
  {
    id: 'students',
    label: 'Students',
    hint: 'Roster, attendance and grades',
    tone: 'mint',
    icon: 'users',
    items: [
      { tab: 'roster', label: 'Students', hint: 'Roster upload & edit', icon: 'users' },
      { tab: 'attendance', label: 'Attendance', hint: 'Mark, register, upload, download', icon: 'check' },
      { tab: 'grades', label: 'Assign grades', hint: 'Publish results', icon: 'award' },
      { tab: 'cgpa', label: 'Class CGPA', hint: 'Class overview', icon: 'chart' },
    ],
    prefetch: () => {
      import('./RosterUpload');
      import('./RosterBrowser');
      import('./MarkAttendance');
      import('./AttendanceUpload');
      import('./AttendanceExport');
      import('./AttendanceRegister');
      import('./AssignGrades');
      import('./ClassCGPA');
    },
  },
  {
    id: 'requests',
    label: 'Requests',
    hint: 'Things waiting on you',
    tone: 'lilac',
    icon: 'medical',
    items: [
      { tab: 'sos', label: 'SOS alerts', hint: 'Live student emergencies', icon: 'alert' },
      { tab: 'medicalLeaves', label: 'Medical leaves', hint: 'Doctor → HOD → teachers', icon: 'medical' },
      { tab: 'complaints', label: 'Complaints & doubts', hint: 'From students', icon: 'chat' },
      { tab: 'reports', label: 'Reported posts', hint: 'Lost & Found flags', icon: 'alert' },
    ],
    prefetch: () => {
      import('./MedicalLeaves');
      import('./SosBoard');
      import('./Complaints');
      import('./Reports');
    },
  },
  {
    id: 'schedules',
    label: 'Schedules',
    hint: 'Timetables, exams and holidays',
    tone: 'yellow',
    icon: 'calendar',
    items: [
      { tab: 'timetable', label: 'Class timetables', hint: 'Import & edit', icon: 'grid' },
      { tab: 'exams', label: 'Exam schedule', hint: 'Mid & end sem', icon: 'calendar' },
      { tab: 'holidays', label: 'Holidays', hint: 'Add a day off', icon: 'sun' },
      { tab: 'roomCleanup', label: 'Room names', hint: 'Fix duplicates', icon: 'door' },
    ],
    prefetch: () => {
      import('./TimetableEditor');
      import('./ExamSchedule');
      import('./AddHoliday');
      import('./RoomCleanup');
    },
  },
  {
    id: 'staff',
    label: 'Staff',
    hint: 'Curriculum, mess and imports',
    tone: 'peach',
    icon: 'book',
    items: [
      { tab: 'curriculum', label: 'Curriculum', hint: 'Subjects per semester', icon: 'book' },
      { tab: 'messSubscribers', label: 'Thali subscribers', hint: 'Mess list', icon: 'thali' },
      { tab: 'inboxImports', label: 'Inbox imports', hint: 'From email', icon: 'inbox' },
    ],
    prefetch: () => {
      import('./CurriculumUpload');
      import('./CurriculumBrowser');
      import('./MessSubscribersUpload');
      import('./InboxImports');
    },
  },
];

export function findTab(tab: Tab): { group: NavGroup; item: NavItem } | null {
  for (const group of NAV) {
    const item = group.items.find((i) => i.tab === tab);
    if (item) return { group, item };
  }
  return null;
}
