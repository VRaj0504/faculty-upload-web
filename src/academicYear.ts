

const ACADEMIC_YEAR_START_MONTH = 6;

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

export function academicYearOptions(count = 5): string[] {
  const currentStart = academicYearStartFor(new Date());
  const options: string[] = [];
  for (let offset = 1; offset >= -(count - 2); offset--) {
    options.push(formatAcademicYear(currentStart + offset));
  }
  return options;
}

export function examYearOptions(count = 8): number[] {
  const now = new Date().getFullYear();
  return Array.from({ length: count }, (_, i) => now - i);
}

export function batchChoices(now: Date = new Date()): { value: string; label: string }[] {
  const start = academicYearStartFor(now);
  const thisYear = formatAcademicYear(start);
  const nextYear = formatAcademicYear(start + 1);
  return [
    { value: thisYear, label: `This year (${thisYear})` },
    { value: nextYear, label: `Next year (${nextYear})` },
  ];
}
