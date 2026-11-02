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
import { loadMyClassSlots, todaysClasses, slotMinutes, formatClock, type MyClassSlot } from './teachingSlots';

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

const normSection = (branch: string, section: string | null | undefined) => {
  const b = String(branch ?? '').toUpperCase().replace(/[\s_-]+/g, '');
  let x = String(section ?? '').toUpperCase().replace(/[\s_-]+/g, '').replace(/^(SECTION|SEC)/, '');
  if (b && x.startsWith(b)) x = x.slice(b.length);
  return x;
};

let autoPickedOnce = false;

export default function AttendanceClassPicker({
  subjectMode,
  onChange,
  quickPick = false,
}: {

  subjectMode: 'required' | 'optional';
  onChange: (s: PickerState | null) => void;
  quickPick?: boolean;
}) {
  const [myToday, setMyToday] = useState<MyClassSlot[]>([]);
  const [pendingCode, setPendingCode] = useState<{ code: string; name: string } | null>(null);
  const [pickNote, setPickNote] = useState('');
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

  useEffect(() => {
    if (!quickPick) return;
    let live = true;
    loadMyClassSlots('')
      .then((all) => live && setMyToday(todaysClasses(all)))
      .catch(() => live && setMyToday([]));
    return () => {
      live = false;
    };
  }, [quickPick]);

  const batches = useMemo(() => (data ? deriveBatches(data.roster) : []), [data]);

  const applySlot = (slot: MyClassSlot) => {
    if (!data) return;
    const b =
      batches.find((x) => !x.pg && currentSemester(x.year, x.pg) === slot.semester) ??
      batches.find((x) => currentSemester(x.year, x.pg) === slot.semester) ??
      null;
    if (!b) {
      setPickNote(`No ${slot.branch} batch is in semester ${slot.semester} on the roster — pick the class below.`);
      return;
    }
    const want = normSection(slot.branch, slot.section);
    const c =
      deriveClasses(data.roster, b).find((x) => x.targets.some((t) => t.branch === slot.branch) && normSection(slot.branch, x.section) === want) ??
      deriveClasses(data.roster, b).find((x) => !x.section && x.targets.some((t) => t.branch === slot.branch)) ??
      null;
    if (!c) {
      setPickNote(`Couldn't find ${slot.branch} ${slot.section} on the roster — pick the class below.`);
      setSel({ ...EMPTY, batchKey: b.key, semester: slot.semester });
      return;
    }
    setPickNote('');
    setTyping(false);
    setSel({ batchKey: b.key, classKey: c.key, semester: slot.semester, subject: null, specialization: '' });
    setPendingCode({ code: slot.subjectCode, name: slot.subjectName });
  };

  useEffect(() => {
    if (!quickPick || autoPickedOnce || !data || !myToday.length || sel.batchKey) return;
    const now = new Date();
    const m = now.getHours() * 60 + now.getMinutes();
    const live = myToday.find((x) => slotMinutes(x.startTime) <= m && m < slotMinutes(x.endTime) + 60);
    if (!live) return;
    autoPickedOnce = true;
    applySlot(live);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quickPick, data, myToday, sel.batchKey]);
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
    loadSubjects(branchesKey.split(','), sel.semester)
      .then((s) => live && setSubjects(s))
      .catch(() => live && setSubjects([]));
    return () => {
      live = false;
    };
  }, [branchesKey, sel.semester, cls]);

  useEffect(() => {
    if (subjects && sel.subject && !subjects.some((s) => s.code === sel.subject!.code)) setTyping(true);
  }, [subjects, sel.subject]);

  useEffect(() => {
    if (!pendingCode || !subjects) return;
    const k = (x: string) => x.replace(/\s+/g, '').toUpperCase();
    const found = subjects.find((x) => k(x.code) === k(pendingCode.code));
    setSel((s) => ({ ...s, subject: found ?? { code: k(pendingCode.code), name: pendingCode.name } }));
    if (!found) setTyping(true);
    setPendingCode(null);
  }, [subjects, pendingCode]);

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

  const nowM = new Date().getHours() * 60 + new Date().getMinutes();
  const isPicked = (x: MyClassSlot) =>
    !!batch &&
    !!cls &&
    sel.semester === x.semester &&
    cls.targets.some((t) => t.branch === x.branch) &&
    normSection(x.branch, cls.section) === normSection(x.branch, x.section) &&
    (sel.subject?.code ?? '').toUpperCase() === x.subjectCode.replace(/\s+/g, '').toUpperCase();

  return (
    <div className="att-picker">
      {quickPick && myToday.length > 0 && (
        <div className="att-quick">
          <div className="att-quick-head">
            <strong>Your classes today</strong>
            <span>Click one to fill everything in</span>
          </div>
          <div className="att-quick-list">
            {myToday.map((x, i) => {
              const a = slotMinutes(x.startTime);
              const b = slotMinutes(x.endTime);
              const live = a <= nowM && nowM < b;
              const later = a > nowM;
              return (
                <button
                  key={`${x.startTime}-${x.subjectCode}-${x.section}-${i}`}
                  type="button"
                  className={`att-quick-item${isPicked(x) ? ' is-picked' : ''}${later ? ' is-later' : ''}`}
                  onClick={() => applySlot(x)}
                >
                  <span className="att-quick-time">{formatClock(x.startTime)}</span>
                  <span className="att-quick-main">
                    <span className="att-quick-subject">{x.subjectName || x.subjectCode}</span>
                    <span className="att-quick-meta">
                      {[x.branch, `Sem ${x.semester}`, normSection(x.branch, x.section) ? x.section : null, x.room].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  <span className={`att-quick-tag${live ? ' is-live' : ''}`}>{live ? 'Now' : later ? 'Later' : 'Done'}</span>
                </button>
              );
            })}
          </div>
          {pickNote && <p className="res-hint" style={{ marginTop: '0.5rem' }}>{pickNote}</p>}
        </div>
      )}
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
