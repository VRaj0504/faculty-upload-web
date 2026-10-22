

export type LabStatus = 'has-lab' | 'no-lab' | 'unknown';

type SlotLike = { subjectCode?: string; room?: string; group?: string };
type TimetableLike = { days?: { slots?: SlotLike[] }[] };

export function normalizeCode(code: string): string {
  return String(code ?? '').replace(/\s+/g, '').toUpperCase();
}

export function labStatusFor(subjectCode: string, timetables: TimetableLike[]): LabStatus {
  const target = normalizeCode(subjectCode);
  if (!target) return 'unknown';

  let scheduled = false;
  for (const timetable of timetables) {
    for (const day of timetable.days ?? []) {
      for (const slot of day.slots ?? []) {
        if (normalizeCode(slot.subjectCode ?? '') !== target) continue;
        scheduled = true;
        if (slot.group || /lab/i.test(slot.room ?? '')) return 'has-lab';
      }
    }
  }
  return scheduled ? 'no-lab' : 'unknown';
}
