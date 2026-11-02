export const VENUES = [
  'Classroom 1',
  'Classroom 2',
  'Classroom 3',
  'Classroom 4',
  'Classroom 5',
  'Classroom 6',
  'CSE Lab 1',
  'CSE Lab 2',
  'ECE Lab 1',
  'ECE Lab 2',
] as const;

export const SLOTS = [
  { id: 'morning', label: 'Morning 9:00–10:00 AM', start: '09:00', end: '10:00' },
  { id: 'evening', label: 'Evening 4:00–5:00 PM', start: '16:00', end: '17:00' },
] as const;

export const slotOf = (start: string, end: string): string => SLOTS.find((s) => s.start === start && s.end === end)?.id ?? (start || end ? 'custom' : '');

export const DEFAULT_GUIDELINES = [
  'Mid semester exams are of 15 or 25 marks, based on the course credit.',
  'Seating arrangement is displayed on the notice board.',
  'It is mandatory to bring the institute identity card.',
  'Students must enter the examination hall 15 minutes before the exam starts.',
  'The halls are under CCTV surveillance. Unfair means lead to disciplinary action.',
];
