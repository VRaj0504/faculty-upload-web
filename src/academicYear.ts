// Mirror of the mobile app's src/utils/academicYear.ts — the portal is a
// separate project with no shared package, so this is duplicated rather
// than imported. Keep the two in sync by hand if the rollover month or
// the label format ever changes; both sides must agree on the exact
// string, since that's what gets compared to decide what a student sees.

// The academic year runs July -> June here, so material uploaded in
// September and in the following February belong to the same cohort.
const ACADEMIC_YEAR_START_MONTH = 6; // 0-indexed: 6 = July

export function formatAcademicYear(startYear: number): string {
  const endShort = String((startYear + 1) % 100).padStart(2, '0');
  return `${startYear}-${endShort}`;
}

export function academicYearStartFor(date: Date): number {
  return date.getMonth() >= ACADEMIC_YEAR_START_MONTH ? date.getFullYear() : date.getFullYear() - 1;
}

export function currentAcademicYear(): string {
  return formatAcademicYear(academicYearStartFor(new Date()));
}

// Newest first so the common case (this year) is the default option.
export function academicYearOptions(count = 5): string[] {
  const currentStart = academicYearStartFor(new Date());
  const options: string[] = [];
  for (let offset = 1; offset >= -(count - 2); offset--) {
    options.push(formatAcademicYear(currentStart + offset));
  }
  return options;
}

// Calendar years an exam paper might be from, newest first — the current
// year back a handful, since the point of keeping old papers is having
// several sittings to practise on. This is the year the exam was HELD
// (2024), deliberately separate from the academic-year label ("2023-24")
// used for cohorts: a paper is filed by when it was sat, a note by which
// batch it was written for.
export function examYearOptions(count = 8): number[] {
  const now = new Date().getFullYear();
  return Array.from({ length: count }, (_, i) => now - i);
}

// The only two answers that make sense when filing Notes, Slides or an
// Assignment: for the students who are here now, or for the batch that
// starts next. Older years would be pointless — no student would ever
// see them — and a five-year list of "2026-27"-style labels, headed by
// a year that hasn't begun, is exactly what made this field confusing.
// "This year" is listed first and is the default, so in the usual case
// nobody has to think about it at all.
//
// `now` is a parameter only so the July rollover can be tested.
export function batchChoices(now: Date = new Date()): { value: string; label: string }[] {
  const start = academicYearStartFor(now);
  const thisYear = formatAcademicYear(start);
  const nextYear = formatAcademicYear(start + 1);
  return [
    { value: thisYear, label: `This year (${thisYear})` },
    { value: nextYear, label: `Next year (${nextYear})` },
  ];
}
