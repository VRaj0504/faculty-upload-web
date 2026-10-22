export const LETTER_GRADES = ["AA", "AB", "BB", "BC", "CC", "CD", "DD", "FF"] as const;
export const SPECIAL_GRADES = ["II", "NA", "XX", "WW", "SS", "ZZ"] as const;
export const ALL_GRADES: string[] = [...LETTER_GRADES, ...SPECIAL_GRADES];

export const GRADE_POINTS: Record<string, number> = {
  AA: 10,
  AB: 9,
  BB: 8,
  BC: 7,
  CC: 6,
  CD: 5,
  DD: 4,
  FF: 0,
};

export const GRADE_LABELS: Record<string, string> = {
  AA: "Outstanding",
  AB: "Excellent",
  BB: "Very good",
  BC: "Good",
  CC: "Average",
  CD: "Below average",
  DD: "Marginal (pass)",
  FF: "Fail",
  II: "Incomplete (medical)",
  NA: "Not appeared",
  XX: "Attendance below 60%",
  WW: "Withdrawn",
  SS: "Satisfactory",
  ZZ: "Not completed",
};

export const ATTEMPT_TYPES = ["regular", "supplementary", "repeat"] as const;
export type AttemptType = (typeof ATTEMPT_TYPES)[number];
export const ATTEMPT_LABELS: Record<AttemptType, string> = {
  regular: "Regular",
  supplementary: "Supplementary",
  repeat: "Repeat (re-registered)",
};

export const RULES = {
  maxFailedCoursesPerYear: 3,
  minCgpa: 4.5,
  minEarnedCreditsByYear: { 1: 23.5, 2: 55, 3: 90, 4: 125, 5: 165 } as Record<number, number>,
  maxSemesters: 12,
  minEarnedShareOfSemester: 0.5,
};

export type ResultInput = {
  subjectCode: string;
  subjectName: string;
  subjectSemester: number;
  credits: number;
  grade: string;
  attempt?: string | null;
  history?: { grade: string; attempt?: string | null }[] | null;
};

export type BacklogKind = "supplementary" | "repeat" | "pending";

export type Backlog = {
  subjectCode: string;
  subjectName: string;
  semester: number;
  year: number;
  credits: number;
  grade: string;
  kind: BacklogKind;
  attempts: number;
  action: string;
};

export type ExamAlert = {
  level: "high" | "medium" | "info";
  title: string;
  detail: string;
  rule: string;
};

export type SemesterSummary = {
  semester: number;
  sgpa: number | null;
  registeredCredits: number;
  earnedCredits: number;
  courses: number;
};

export type Standing = "no-results" | "clear" | "backlogs" | "at-risk";

export type ExamStatus = {
  yearOfStudy: number;
  currentSemester: number;
  earnedCredits: number;
  cgpa: number | null;
  semesters: SemesterSummary[];
  backlogs: Backlog[];
  counts: { supplementary: number; repeat: number; pending: number; total: number };
  failedByYear: Record<number, number>;
  yearBack: boolean;
  creditTarget: { year: number; needed: number; earned: number; checked: boolean } | null;
  alerts: ExamAlert[];
  standing: Standing;
};

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function isPassGrade(grade: string): boolean {
  return (grade in GRADE_POINTS && grade !== "FF") || grade === "SS";
}

export function earnsCredits(grade: string): boolean {
  return grade in GRADE_POINTS && grade !== "FF";
}

export function backlogKind(grade: string): BacklogKind | null {
  if (grade === "FF" || grade === "NA") return "supplementary";
  if (grade === "XX" || grade === "WW" || grade === "ZZ") return "repeat";
  if (grade === "II") return "pending";
  return null;
}

export function backlogAction(grade: string): string {
  switch (grade) {
    case "FF":
      return "Appear in the supplementary exam for this course (Rules 5.5, 14.4).";
    case "NA":
      return "You didn't appear. Take the supplementary exam (Rule 14.3).";
    case "XX":
      return "Re-register and repeat this course when it is next offered (Rules 5.6, 7.11).";
    case "WW":
      return "Withdrawn. Register for this course again.";
    case "ZZ":
      return "Redo the training until you get SS (Rule 7.12).";
    case "II":
      return "Complete the pending work. II is converted to a regular grade (Rule 6.4).";
    default:
      return "";
  }
}

export function yearOfSemester(semester: number): number {
  return Math.max(1, Math.ceil(semester / 2));
}

export function academicYearStart(today: Date): number {
  return today.getMonth() >= 6 ? today.getFullYear() : today.getFullYear() - 1;
}

export function yearOfStudyFor(admissionYear: number, today: Date = new Date()): number {
  return Math.max(1, academicYearStart(today) - admissionYear + 1);
}

export function semesterFor(admissionYear: number, today: Date = new Date()): number {
  const year = yearOfStudyFor(admissionYear, today);
  return (year - 1) * 2 + (today.getMonth() >= 6 ? 1 : 2);
}

export function attemptsOf(r: ResultInput): number {
  return 1 + (r.history?.length ?? 0);
}

export function summariseSemesters(results: ResultInput[]): SemesterSummary[] {
  const bySem = new Map<number, ResultInput[]>();
  for (const r of results) {
    const list = bySem.get(r.subjectSemester) ?? [];
    list.push(r);
    bySem.set(r.subjectSemester, list);
  }
  return Array.from(bySem.entries())
    .map(([semester, list]) => {
      const graded = list.filter((r) => r.grade in GRADE_POINTS);
      const gradedCredits = graded.reduce((s, r) => s + r.credits, 0);
      const points = graded.reduce((s, r) => s + r.credits * GRADE_POINTS[r.grade], 0);
      return {
        semester,
        sgpa: gradedCredits > 0 ? round2(points / gradedCredits) : null,
        registeredCredits: list.reduce((s, r) => s + r.credits, 0),
        earnedCredits: list.filter((r) => earnsCredits(r.grade)).reduce((s, r) => s + r.credits, 0),
        courses: list.length,
      };
    })
    .sort((a, b) => a.semester - b.semester);
}

export function computeCgpa(results: ResultInput[]): number | null {
  const passed = results.filter((r) => earnsCredits(r.grade));
  const credits = passed.reduce((s, r) => s + r.credits, 0);
  if (credits <= 0) return null;
  const points = passed.reduce((s, r) => s + r.credits * GRADE_POINTS[r.grade], 0);
  return round2(points / credits);
}

export function evaluateStudent(
  results: ResultInput[],
  admissionYear: number | null | undefined,
  today: Date = new Date(),
): ExamStatus {
  const yearOfStudy = admissionYear ? yearOfStudyFor(admissionYear, today) : 1;
  const currentSemester = admissionYear ? semesterFor(admissionYear, today) : 1;
  const semesters = summariseSemesters(results);
  const earnedCredits = semesters.reduce((s, x) => s + x.earnedCredits, 0);
  const cgpa = computeCgpa(results);

  const backlogs: Backlog[] = results
    .map((r) => {
      const kind = backlogKind(r.grade);
      if (!kind) return null;
      return {
        subjectCode: r.subjectCode,
        subjectName: r.subjectName,
        semester: r.subjectSemester,
        year: yearOfSemester(r.subjectSemester),
        credits: r.credits,
        grade: r.grade,
        kind,
        attempts: attemptsOf(r),
        action: backlogAction(r.grade),
      } as Backlog;
    })
    .filter((b): b is Backlog => b !== null)
    .sort((a, b) => a.semester - b.semester || a.subjectCode.localeCompare(b.subjectCode));

  const counts = {
    supplementary: backlogs.filter((b) => b.kind === "supplementary").length,
    repeat: backlogs.filter((b) => b.kind === "repeat").length,
    pending: backlogs.filter((b) => b.kind === "pending").length,
    total: 0,
  };
  counts.total = counts.supplementary + counts.repeat;

  const failedByYear: Record<number, number> = {};
  const xxByYear: Record<number, number> = {};
  for (const b of backlogs) {
    if (b.kind === "pending") continue;
    failedByYear[b.year] = (failedByYear[b.year] ?? 0) + 1;
    if (b.grade === "XX") xxByYear[b.year] = (xxByYear[b.year] ?? 0) + 1;
  }

  const alerts: ExamAlert[] = [];
  let yearBack = false;

  for (const [yearKey, failed] of Object.entries(failedByYear)) {
    const year = Number(yearKey);
    if (failed <= RULES.maxFailedCoursesPerYear) continue;
    yearBack = true;
    const xx = xxByYear[year] ?? 0;
    alerts.push({
      level: "high",
      title: year >= yearOfStudy ? `Year back risk: ${failed} uncleared courses in Year ${year}` : `${failed} uncleared courses from Year ${year}`,
      detail:
        year >= yearOfStudy
          ? `You can't register for Year ${year + 1} courses if more than ${RULES.maxFailedCoursesPerYear} courses of Year ${year} are not cleared. Clear them in the supplementary exam, or you'll repeat them next year.${xx > 3 ? " With more than 3 XX grades you must also pay full fees and repeat those courses." : ""}`
          : `More than ${RULES.maxFailedCoursesPerYear} courses of an earlier year are still not cleared. Check with the exam office whether you have been held back.`,
      rule: xx > 3 ? "Rules 14.5, 5.6" : "Rule 14.5",
    });
  }

  const unclearedInYear = (y: number) => backlogs.filter((b) => b.year === y && b.kind !== "pending").length;
  if (yearOfStudy >= 2 && unclearedInYear(1) > 0) {
    alerts.push({
      level: currentSemester >= 4 ? "high" : "medium",
      title: `Clear all Year 1 courses before Semester 5`,
      detail: `${unclearedInYear(1)} Year 1 course(s) are still not cleared. You won't be allowed to register for Semester 5 until they are.`,
      rule: "Rule 14.5",
    });
  }
  if (yearOfStudy >= 3 && unclearedInYear(2) > 0) {
    alerts.push({
      level: currentSemester >= 6 ? "high" : "medium",
      title: `Clear all Year 2 courses before Semester 7`,
      detail: `${unclearedInYear(2)} Year 2 course(s) are still not cleared. You won't be allowed to register for Semester 7 until they are.`,
      rule: "Rule 14.5",
    });
  }

  let creditTarget: ExamStatus["creditTarget"] = null;
  const needed = RULES.minEarnedCreditsByYear[yearOfStudy];
  if (needed !== undefined && results.length > 0) {
    const lastSemOfYear = yearOfStudy * 2;
    const semsWithResults = new Set(semesters.map((s) => s.semester));
    let complete = true;
    for (let s = 1; s <= lastSemOfYear; s++) if (!semsWithResults.has(s)) complete = false;
    creditTarget = { year: yearOfStudy, needed, earned: earnedCredits, checked: complete };
    if (complete && earnedCredits < needed) {
      alerts.push({
        level: "high",
        title: `Below the minimum earned credits for Year ${yearOfStudy}`,
        detail: `You have ${earnedCredits} earned credits. At least ${needed} are needed by the end of Year ${yearOfStudy}, or registration can be terminated. Talk to your HOD or the exam office.`,
        rule: "Rule 10.3",
      });
    }
  }

  if (cgpa !== null && cgpa <= RULES.minCgpa) {
    alerts.push({
      level: "medium",
      title: "CGPA at or below 4.5",
      detail: `Your CGPA is ${cgpa.toFixed(2)}. Students at or below 4.5 are reviewed by the Academic Performance Review Committee (APRC), and 4.5 is also the minimum for the degree.`,
      rule: "Rules 9.2, 15.2",
    });
  }

  const latest = semesters[semesters.length - 1];
  if (latest && latest.registeredCredits > 0 && latest.earnedCredits < latest.registeredCredits * RULES.minEarnedShareOfSemester) {
    alerts.push({
      level: "medium",
      title: `Earned under half the credits in Semester ${latest.semester}`,
      detail: `${latest.earnedCredits} of ${latest.registeredCredits} credits earned. Students below 50% are reviewed by the APRC, which may limit how many courses you can take next semester.`,
      rule: "Rules 9.1, 9.3",
    });
  }

  if (currentSemester > RULES.maxSemesters) {
    alerts.push({
      level: "info",
      title: "Past the normal maximum duration",
      detail: "The degree must normally be completed within 12 semesters (14 with a medical withdrawal).",
      rule: "Rules 8.1, 8.2",
    });
  }

  const order = { high: 0, medium: 1, info: 2 };
  alerts.sort((a, b) => order[a.level] - order[b.level]);

  let standing: Standing;
  if (results.length === 0) standing = "no-results";
  else if (alerts.some((a) => a.level === "high")) standing = "at-risk";
  else if (counts.total > 0 || counts.pending > 0) standing = "backlogs";
  else standing = "clear";

  return {
    yearOfStudy,
    currentSemester,
    earnedCredits,
    cgpa,
    semesters,
    backlogs,
    counts,
    failedByYear,
    yearBack,
    creditTarget,
    alerts,
    standing,
  };
}
