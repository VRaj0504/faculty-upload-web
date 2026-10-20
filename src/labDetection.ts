// Whether a subject has a lab, worked out from the timetables that are
// already published — so there is no separate "has lab" list for anyone
// to maintain or get out of date. Assignments are only set for subjects
// with a lab, so this is what the upload form uses to decide whether
// "Assignment" is a valid choice.
//
// A slot counts as lab time if it is split into groups (a lab is run as
// Group 1 / Group 2 in parallel) or held in a room with "lab" in its
// name (PHY Lab 1, CSE Lab 3, ECE Lab 2). Either signal is enough
// because the data isn't always complete: a slot might name its room but
// not its group, or the reverse.

export type LabStatus = 'has-lab' | 'no-lab' | 'unknown';

type SlotLike = { subjectCode?: string; room?: string; group?: string };
type TimetableLike = { days?: { slots?: SlotLike[] }[] };

// Timetable data writes codes both ways ("AS 101" from the PDFs, "AS101"
// from the curriculum list), so compare with spacing and case removed.
export function normalizeCode(code: string): string {
  return String(code ?? '').replace(/\s+/g, '').toUpperCase();
}

// 'has-lab'  — at least one of its slots is lab time.
// 'no-lab'   — it IS scheduled, and none of its slots are lab time.
// 'unknown'  — nothing published to judge from (no timetable yet, or the
//              subject isn't scheduled anywhere). Deliberately NOT treated
//              as "no lab": blocking an upload because data is missing
//              would punish faculty for the timetable being incomplete.
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
