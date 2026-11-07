

import type { IconName } from './icons';

export type Tab =
  | 'home'
  | 'resources'
  | 'announcements'
  | 'notices'
  | 'myTimetable'
  | 'roster'
  | 'attendance'
  | 'grades'
  | 'cgpa'
  | 'examStatus'
  | 'examResults'
  | 'marks'
  | 'examNotices'
  | 'medicalLeaves'
  | 'sos'
  | 'complaints'
  | 'timetable'
  | 'exams'
  | 'quizzes'
  | 'holidays'
  | 'roomCleanup'
  | 'curriculum'
  | 'messSubscribers'
  | 'placementStats'
  | 'classChanges'
  | 'inboxImports'
  | 'directorOverview'
  | 'meetings';

export type Tone = 'blue' | 'mint' | 'lilac' | 'yellow' | 'peach' | 'pink';

export type SubTab = { tab: Tab; label: string; hint: string };
export type NavItem = { tab: Tab; label: string; hint: string; icon: IconName; sub?: SubTab[] };
export type NavGroup = {
  id: string;
  label: string;
  hint: string;
  tone: Tone;
  icon: IconName;
  items: NavItem[];
  prefetch: () => void;
  leaderOnly?: boolean;
};

export const toneVars = (tone: Tone) => ({
  background: `var(--tone-${tone}-bg)`,
  color: `var(--tone-${tone}-fg)`,
});

export const NAV: NavGroup[] = [
  {
    id: 'director',
    label: "Director's office",
    hint: 'Complaints, SOS and meetings',
    tone: 'blue',
    icon: 'chart',
    leaderOnly: true,
    items: [
      { tab: 'directorOverview', label: 'Overview', hint: 'Complaints and SOS at a glance', icon: 'chart' },
      { tab: 'meetings', label: 'Meetings', hint: 'Call students or faculty to a meeting', icon: 'users' },
    ],
    prefetch: () => {
      import('./DirectorDashboard');
      import('./Meetings');
    },
  },
  {
    id: 'teaching',
    label: 'Teaching',
    hint: 'Files and notices for your classes',
    tone: 'blue',
    icon: 'upload',
    items: [
      { tab: 'resources', label: 'Resources', hint: 'Notes, papers & slides', icon: 'upload' },
      { tab: 'notices', label: 'Notices', hint: 'Post to the app notice board', icon: 'inbox' },
      { tab: 'announcements', label: 'Announcements', hint: 'Notify a class', icon: 'megaphone' },
      { tab: 'myTimetable', label: 'My timetable', hint: 'Your week', icon: 'clock' },
    ],
    prefetch: () => {
      import('./Upload');
      import('./Announcements');
      import('./Notices');
      import('./MyTimetable');
    },
  },
  {
    id: 'students',
    label: 'Students',
    hint: 'Roster, profiles and attendance',
    tone: 'mint',
    icon: 'users',
    items: [
      { tab: 'roster', label: 'Students', hint: 'Roster, profiles, CGPA & backlogs', icon: 'users' },
      { tab: 'attendance', label: 'Attendance', hint: 'Mark, register, upload, download', icon: 'check' },
    ],
    prefetch: () => {
      import('./RosterUpload');
      import('./RosterBrowser');
      import('./MarkAttendance');
      import('./AttendanceUpload');
      import('./AttendanceExport');
      import('./AttendanceRegister');
    },
  },
  {
    id: 'exams',
    label: 'Exam cell',
    hint: 'Date sheets, grades, results and backlogs',
    tone: 'pink',
    icon: 'award',
    items: [
      {
        tab: 'exams',
        label: 'Exams & quizzes',
        hint: 'Date sheets, quizzes and exam notices',
        icon: 'calendar',
        sub: [
          { tab: 'exams', label: 'Date sheets', hint: 'Mid sem and end sem timetables for each class.' },
          { tab: 'quizzes', label: 'Quizzes', hint: 'Quiz date, time, rooms and syllabus.' },
          { tab: 'examNotices', label: 'Notices', hint: 'Supplementary, make-up and room or timing changes.' },
        ],
      },
      {
        tab: 'marks',
        label: 'Marks & grades',
        hint: 'Upload marks, then give grades',
        icon: 'award',
        sub: [
          { tab: 'marks', label: '1 · Marks', hint: 'Upload quiz, mid sem and end sem marks. Students see them in the app.' },
          { tab: 'grades', label: '2 · Grades', hint: 'At the end of the semester, turn total marks into letter grades for your subject.' },
          { tab: 'examResults', label: '3 · Result sheet', hint: 'Exam cell only: upload the official result sheet for a whole class.' },
        ],
      },
      {
        tab: 'examStatus',
        label: 'Results & backlogs',
        hint: 'Backlogs, year back and class CGPA',
        icon: 'chart',
        sub: [
          { tab: 'examStatus', label: 'Backlogs & status', hint: 'Who has backlogs, year back risk and credits.' },
          { tab: 'cgpa', label: 'Class CGPA', hint: 'SGPA and CGPA for a whole class.' },
        ],
      },
    ],
    prefetch: () => {
      import('./ExamSchedule');
      import('./AssignGrades');
      import('./UploadMarks');
      import('./ClassCGPA');
      import('./ExamCell');
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
      { tab: 'medicalLeaves', label: 'Medical leaves', hint: 'Office → MO → HOD, Dean, JR', icon: 'medical' },
      { tab: 'complaints', label: 'Complaints & doubts', hint: 'From students', icon: 'chat' },
    ],
    prefetch: () => {
      import('./MedicalLeaves');
      import('./SosBoard');
      import('./Complaints');
    },
  },
  {
    id: 'schedules',
    label: 'Schedules',
    hint: 'Timetables, holidays and rooms',
    tone: 'yellow',
    icon: 'calendar',
    items: [
      { tab: 'timetable', label: 'Class timetables', hint: 'Import & edit', icon: 'grid' },
      { tab: 'holidays', label: 'Holidays', hint: 'Add a day off', icon: 'sun' },
      { tab: 'roomCleanup', label: 'Room names', hint: 'Fix duplicates', icon: 'door' },
      { tab: 'classChanges', label: 'Class changes', hint: 'Cancelled or moved classes', icon: 'calendar' },
    ],
    prefetch: () => {
      import('./ClassChanges');
      import('./TimetableEditor');
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
      { tab: 'messSubscribers', label: 'Mess', hint: 'Prices & thali subscribers', icon: 'thali' },
      { tab: 'placementStats', label: 'Placements', hint: 'Numbers on the app page', icon: 'chart' },
      { tab: 'inboxImports', label: 'Inbox imports', hint: 'From email', icon: 'inbox' },
    ],
    prefetch: () => {
      import('./CurriculumUpload');
      import('./CurriculumBrowser');
      import('./MessSubscribersUpload');
      import('./PlacementStats');
      import('./InboxImports');
    },
  },
];

export function findTab(tab: Tab): { group: NavGroup; item: NavItem; sub: SubTab | null } | null {
  for (const group of NAV) {
    for (const item of group.items) {
      const s = item.sub?.find((x) => x.tab === tab) ?? null;
      if (item.tab === tab || s) return { group, item, sub: s };
    }
  }
  return null;
}

export const ALL_NAV_TABS: Tab[] = NAV.flatMap((g) => g.items.flatMap((i) => [i.tab, ...(i.sub ?? []).map((s) => s.tab)]));

export const navFor = (isLeader: boolean): NavGroup[] => NAV.filter((g) => !g.leaderOnly || isLeader);
