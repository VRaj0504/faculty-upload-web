import { useEffect, useMemo, useState } from 'react';
import {
  batchLabel,
  currentSemester,
  deriveBatches,
  deriveClasses,
  semesterOptions,
  type Batch,
  type ClassGroup,
  type RosterEntry,
} from './attendanceCore';
import { loadHolidayOverrides, loadRoster, loadSubjects, type SubjectOption } from './attendanceData';

export type AttendanceSelection = {
  batchKey: string;
  classKey: string;
  semester: number | null;
  subject: SubjectOption | null;
  specialization: string;
};

const EMPTY: AttendanceSelection = { batchKey: '', classKey: '', semester: null, subject: null, specialization: '' };

let remembered: AttendanceSelection = EMPTY;

let cache: Promise<{ roster: RosterEntry[]; holidays: Map<string, string> }> | null = null;
export function loadAttendanceBasics() {
  if (!cache) {
    cache = Promise.all([loadRoster(), loadHolidayOverrides()]).then(([roster, holidays]) => ({ roster, holidays }));
    cache.catch(() => (cache = null));
  }
  return cache;
}

export type PickerState = {
  roster: RosterEntry[];
  holidays: Map<string, string>;
  batch: Batch | null;
  cls: ClassGroup | null;
  semester: number | null;
  subject: SubjectOption | null;
  specialization: string;

  students: RosterEntry[];
};

export default function AttendanceClassPicker({
  subjectMode,
  onChange,
}: {

  subjectMode: 'required' | 'optional';
  onChange: (s: PickerState | null) => void;
}) {
  const [data, setData] = useState<{ roster: RosterEntry[]; holidays: Map<string, string> } | null>(null);
  const [loadError, setLoadError] = useState('');
  const [sel, setSel] = useState<AttendanceSelection>(remembered);
  const [subjects, setSubjects] = useState<SubjectOption[] | null>(null);
  const [typing, setTyping] = useState(false);

  useEffect(() => {
    loadAttendanceBasics()
      .then(setData)
      .catch((e) => setLoadError(`Couldn’t load the roster: ${e?.message ?? 'unknown error'}. Reload the page to try again.`));
  }, []);

  const batches = useMemo(() => (data ? deriveBatches(data.roster) : []), [data]);
  const batch = batches.find((b) => b.key === sel.batchKey) ?? null;
  const classes = useMemo(() => (data && batch ? deriveClasses(data.roster, batch) : []), [data, batch]);
  const cls = classes.find((c) => c.key === sel.classKey) ?? null;

  useEffect(() => {
    if (!data) return;
    if (sel.batchKey && !batch) setSel(EMPTY);
    else if (sel.classKey && batch && !cls) setSel((s) => ({ ...s, classKey: '', subject: null, specialization: '' }));
  }, [data, batch, cls, sel.batchKey, sel.classKey]);

  useEffect(() => {
    remembered = sel;
  }, [sel]);

  const branchesKey = cls ? cls.targets.map((t) => t.branch).join(',') : '';
  useEffect(() => {
    setSubjects(null);
    if (!cls || !sel.semester) return;
    let live = true;
    loadSubjects(branchesKey.split(','), sel.semester).then((s) => live && setSubjects(s));
    return () => {
      live = false;
    };
  }, [branchesKey, sel.semester, cls]);

  useEffect(() => {
    if (subjects && sel.subject && !subjects.some((s) => s.code === sel.subject!.code)) setTyping(true);
  }, [subjects, sel.subject]);

  const students = useMemo(() => {
    if (!cls) return [];
    return sel.specialization ? cls.students.filter((s) => s.specialization === sel.specialization) : cls.students;
  }, [cls, sel.specialization]);

  useEffect(() => {
    if (!data) return;
    const subjectOk = subjectMode === 'optional' || (!!sel.subject?.code.trim() && !!sel.subject?.name.trim());
    if (!batch || !cls || !sel.semester || !subjectOk) {
      onChange(null);
      return;
    }
    onChange({
      roster: data.roster,
      holidays: data.holidays,
      batch,
      cls,
      semester: sel.semester,
      subject: sel.subject && sel.subject.code.trim() ? { code: sel.subject.code.trim(), name: sel.subject.name.trim() } : null,
      specialization: sel.specialization,
      students,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, batch, cls, sel.semester, sel.subject?.code, sel.subject?.name, sel.specialization, students, subjectMode]);

  if (loadError) return <p className="notice notice-error">{loadError}</p>;
  if (!data) return <p className="res-hint">Loading classes…</p>;
  if (!batches.length) return <p className="notice notice-error">The roster is empty — upload it under Students first.</p>;

  return (
    <div className="att-picker">
      <div className="att-row">
        <div className="att-field">
          <label>Batch</label>
          <select
            value={sel.batchKey}
            onChange={(e) => {
              const b = batches.find((x) => x.key === e.target.value);
              setSel({ ...EMPTY, batchKey: e.target.value, semester: b ? currentSemester(b.year, b.pg) : null });
              setTyping(false);
            }}
          >
            <option value="">Select a batch…</option>
            {batches.map((b) => (
              <option key={b.key} value={b.key}>{batchLabel(b)}</option>
            ))}
          </select>
        </div>
        <div className="att-field">
          <label>Class</label>
          <select
            value={sel.classKey}
            disabled={!batch}
            onChange={(e) => {
              setSel((s) => ({ ...s, classKey: e.target.value, subject: null, specialization: '' }));
              setTyping(false);
            }}
          >
            <option value="">{batch ? 'Select a class…' : 'Pick a batch first'}</option>
            {classes.map((c) => (
              <option key={c.key} value={c.key}>{c.label} · {c.students.length} students</option>
            ))}
          </select>
        </div>
        <div className="att-field att-narrow">
          <label>Semester</label>
          <select
            value={sel.semester ?? ''}
            disabled={!batch}
            onChange={(e) => {
              setSel((s) => ({ ...s, semester: e.target.value ? Number(e.target.value) : null, subject: null }));
              setTyping(false);
            }}
          >
            <option value="">—</option>
            {batch &&
              semesterOptions(batch.pg).map((n) => (
                <option key={n} value={n}>
                  Sem {n}
                  {n === currentSemester(batch.year, batch.pg) ? ' (now)' : ''}
                </option>
              ))}
          </select>
        </div>
      </div>

      <div className="att-row">
        <div className="att-field att-wide">
          <label>Subject</label>
          <select
            disabled={!cls || !sel.semester}
            value={typing ? '__other__' : sel.subject?.code ?? ''}
            onChange={(e) => {
              if (e.target.value === '__other__') {
                setTyping(true);
                setSel((s) => ({ ...s, subject: { code: '', name: '' } }));
                return;
              }
              setTyping(false);
              const found = subjects?.find((x) => x.code === e.target.value) ?? null;
              setSel((s) => ({ ...s, subject: found }));
            }}
          >
            <option value="">
              {!cls || !sel.semester
                ? 'Pick class and semester first'
                : subjects === null
                  ? 'Loading subjects…'
                  : subjectMode === 'optional'
                    ? 'All subjects'
                    : 'Select a subject…'}
            </option>
            {subjects?.map((s) => (
              <option key={s.code} value={s.code}>{s.code} — {s.name}</option>
            ))}
            {cls && sel.semester && <option value="__other__">Other / elective (type it)</option>}
          </select>
          {typing && (
            <div className="att-row" style={{ marginTop: '0.5rem' }}>
              <input
                style={{ width: 120 }}
                placeholder="Code e.g. CS351"
                value={sel.subject?.code ?? ''}
                onChange={(e) => setSel((s) => ({ ...s, subject: { code: e.target.value.toUpperCase().replace(/\s+/g, ''), name: s.subject?.name ?? '' } }))}
              />
              <input
                style={{ flex: 1 }}
                placeholder="Subject name"
                value={sel.subject?.name ?? ''}
                onChange={(e) => setSel((s) => ({ ...s, subject: { code: s.subject?.code ?? '', name: e.target.value } }))}
              />
            </div>
          )}
          {typing && (
            <p className="res-hint">
              Use the exact code from the curriculum — students only see attendance for subject codes in their own
              curriculum.
            </p>
          )}
        </div>
        {cls && cls.specializations.length > 0 && (
          <div className="att-field">
            <label>Who takes it</label>
            <select value={sel.specialization} onChange={(e) => setSel((s) => ({ ...s, specialization: e.target.value }))}>
              <option value="">Whole class</option>
              {cls.specializations.map((sp) => (
                <option key={sp} value={sp}>Only {sp}</option>
              ))}
            </select>
          </div>
        )}
      </div>
    </div>
  );
}
