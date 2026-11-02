import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Att, Ev, Med, Sig, Sign, SignRole } from './medicalData';
import {
  ALL_ROLES,
  KIND_LABEL,
  LATE_LIMIT_DAYS,
  ROLE_TITLE,
  STAGE_LABEL,
  STAGE_TONE,
  act,
  daysOf,
  loadSignature,
  myRoles,
  nameFor,
  openFile,
  prettyIso,
  removeFile,
  saveSignature,
  signOf,
  signatureFromImage,
  stamp,
  toCsv,
  uploadCertificate,
  watchEvents,
} from './medicalData';

export type Me = { uid: string; email: string; name: string; admin: boolean };

const INK = '#1E2A78';
const r1 = (n: number) => Math.round(n * 10) / 10;

export function SigSvg({ sig, height = 44 }: { sig: Sig; height?: number }) {
  const width = Math.round((sig.w / sig.h) * height);
  if (sig.png) return <img src={`data:image/png;base64,${sig.png}`} width={width} height={height} alt="Signature" style={{ objectFit: 'contain' }} />;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${sig.w} ${sig.h}`} aria-label="Signature">
      {sig.paths.map((d, i) => (
        <path key={i} d={d} stroke={INK} strokeWidth={Math.max(2.4, sig.w / 70)} fill="none" strokeLinecap="round" strokeLinejoin="round" />
      ))}
    </svg>
  );
}

export function SignaturePad({ value, onChange, height = 170 }: { value: Sig | null; onChange: (s: Sig | null) => void; height?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState('');
  const cur = useRef('');
  const pts = useRef(0);
  const [width, setWidth] = useState(0);
  const [upErr, setUpErr] = useState('');
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.round(el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pos = (e: React.PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    return [r1(e.clientX - r.left), r1(e.clientY - r.top)];
  };
  const down = (e: React.PointerEvent) => {
    e.preventDefault();
    if (value?.png) onChange(null);
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const [x, y] = pos(e);
    cur.current = `M${x} ${y}`;
    pts.current = 1;
    setLive(cur.current);
  };
  const move = (e: React.PointerEvent) => {
    if (!cur.current || pts.current > 600) return;
    const [x, y] = pos(e);
    cur.current += ` L${x} ${y}`;
    pts.current += 1;
    setLive(cur.current);
  };
  const up = () => {
    let d = cur.current;
    if (!d || !width) return;
    if (pts.current === 1) {
      const m = d.match(/^M([\d.]+) ([\d.]+)/);
      if (m) d += ` L${r1(Number(m[1]) + 0.5)} ${r1(Number(m[2]) + 0.5)}`;
    }
    const base = value && !value.png && value.w === width && value.h === height ? value.paths : [];
    onChange({ w: width, h: height, paths: [...base, d].slice(-200) });
    cur.current = '';
    setLive('');
  };
  const scaled = value && !value.png && (value.w !== width || value.h !== height);

  return (
    <div>
      <div
        ref={box}
        className="med-pad"
        style={{ height }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onPointerLeave={() => cur.current && up()}
      >
        <div className="med-pad-line" />
        {!value && !live && <div className="med-pad-hint">Sign here with your mouse, pen or finger</div>}
        {value?.png && !live && (
          <img
            src={`data:image/png;base64,${value.png}`}
            alt="Your signature"
            style={{ position: 'absolute', inset: 12, width: 'calc(100% - 24px)', height: 'calc(100% - 24px)', objectFit: 'contain', pointerEvents: 'none' }}
          />
        )}
        {width > 0 && !value?.png && (
          <svg width={width} height={height} viewBox={scaled ? `0 0 ${value!.w} ${value!.h}` : undefined} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
            {(value?.paths ?? []).map((d, i) => (
              <path key={i} d={d} stroke={INK} strokeWidth={2.4} fill="none" strokeLinecap="round" strokeLinejoin="round" />
            ))}
            {live && <path d={live} stroke={INK} strokeWidth={2.4} fill="none" strokeLinecap="round" strokeLinejoin="round" />}
          </svg>
        )}
      </div>
      <div className="med-pad-foot">
        <span>Draw it, or upload a photo of your signature on white paper.</span>
        <span style={{ display: 'flex', gap: '0.9rem' }}>
          <input
            ref={picker}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              setUpErr('');
              try {
                onChange(await signatureFromImage(f));
              } catch (x) {
                setUpErr((x as Error).message);
              }
            }}
          />
          <button type="button" className="link-button" onClick={() => picker.current?.click()}>
            Upload signature
          </button>
          <button type="button" className="link-button" onClick={() => onChange(null)} disabled={!value}>
            Clear
          </button>
        </span>
      </div>
      {upErr && <div className="notice notice-error">{upErr}</div>}
    </div>
  );
}

export function StampMark({ decision, at }: { decision: Sign['decision']; at?: string }) {
  return (
    <span className={`med-stamp ${decision === 'approved' ? 'ok' : 'no'}`}>
      <b>{decision === 'approved' ? 'APPROVED' : 'NOT APPROVED'}</b>
      {at && <small>{at}</small>}
    </span>
  );
}

export function StagePill({ m }: { m: Med }) {
  return <span className={`med-pill tone-${STAGE_TONE[m.stage]}`}>{STAGE_LABEL[m.stage]}</span>;
}

export function Flags({ m }: { m: Med }) {
  const f: { bad: boolean; t: string }[] = [];
  if (m.late) f.push({ bad: true, t: `LATE · ${m.daysAfterRejoining} days after rejoining (limit ${LATE_LIMIT_DAYS})` });
  else if (m.daysAfterRejoining != null) f.push({ bad: false, t: `On time · ${m.daysAfterRejoining} day${m.daysAfterRejoining === 1 ? '' : 's'} after rejoining` });
  if (m.intimationMissing) f.push({ bad: true, t: 'No intimation email attached' });
  else if (m.intimationLate) f.push({ bad: true, t: 'Intimation after 24 hours' });
  if ((m.resubmissions ?? 0) > 0) f.push({ bad: false, t: `Resubmitted ${m.resubmissions}×` });
  if (!f.length) return null;
  return (
    <div className="med-flags">
      {f.map((x) => (
        <span key={x.t} className={x.bad ? 'bad' : ''}>
          {x.t}
        </span>
      ))}
    </div>
  );
}

function History({ id }: { id: string }) {
  const [ev, setEv] = useState<Ev[] | null>(null);
  useEffect(() => watchEvents(id, setEv), [id]);
  if (!ev) return <p className="med-soft">Loading history…</p>;
  return (
    <ol className="med-history">
      {ev.map((e) => (
        <li key={e.id} className={e.decision === 'not_approved' ? 'no' : e.decision === 'approved' ? 'ok' : ''}>
          <div>
            <b>{e.action}</b> · {e.byName}
            {e.role ? ` (${e.role})` : ''}
          </div>
          <small>{stamp(e.at)}</small>
          {e.note && <em>“{e.note}”</em>}
        </li>
      ))}
    </ol>
  );
}

function Downloads({ m }: { m: Med }) {
  const [busy, setBusy] = useState(false);
  const final = ['teachers', 'done', 'rejected'].includes(m.stage);
  return (
    <div className="med-dl">
      {m.formPdfPath && (
        <button type="button" className="button-secondary" onClick={() => openFile(m.formPdfPath!)}>
          {final ? 'Signed form (PDF)' : 'Current form (PDF)'}
        </button>
      )}
      {m.bundlePath && (
        <button type="button" className="button-secondary" onClick={() => openFile(m.bundlePath!)}>
          Full bundle (PDF)
        </button>
      )}
      {(!m.formPdfPath || final) && (
        <button
          type="button"
          className={m.formPdfPath ? 'link-button' : 'button-secondary'}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await act({ leaveId: m.id, action: 'rebuild' });
            } catch (e) {
              alert((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Preparing…' : m.formPdfPath ? 'Regenerate PDFs' : 'Prepare PDF'}
        </button>
      )}
    </div>
  );
}

function SignRow({ m, r }: { m: Med; r: SignRole }) {
  const s = signOf(m, r);
  return (
    <div className="med-signrow">
      <div className="med-signrow-who">
        <small>{ROLE_TITLE[r]}</small>
        <b>{s?.byName ?? nameFor(m, r)}</b>
        {s?.comment ? <em>“{s.comment}”</em> : !s ? <span className="med-soft">Not signed yet</span> : null}
      </div>
      {s && (
        <div className="med-signrow-mark">
          <StampMark decision={s.decision} at={stamp(s.at)} />
          <SigSvg sig={s.signature} />
        </div>
      )}
    </div>
  );
}

export function Details({ m }: { m: Med }) {
  const year = m.yearOfStudy ? ['', '1st', '2nd', '3rd', '4th', '5th'][m.yearOfStudy] ?? `${m.yearOfStudy}th` : null;
  const cells: [string, string][] = [
    ['Reg. No.', m.studentEnrollmentNumber ?? '—'],
    ['Branch & Year', [m.branch, year ? `${year} Year` : null].filter(Boolean).join(', ') || '—'],
    ['Semester', m.semester ? String(m.semester) : '—'],
    ['CGPA', m.cgpa || '—'],
    ['Absent', `${prettyIso(m.fromDate)} – ${prettyIso(m.toDate)} · ${daysOf(m)} d`],
    ['Rejoined', prettyIso(m.rejoinedOn)],
    ['Intimation', m.intimationSent ? `Sent ${prettyIso(m.intimationDate)}` : 'Not sent'],
    ['HOD', `${m.hodName ?? ''}${m.hodDepartment ? ` · ${m.hodDepartment}` : ''}`],
  ];
  return (
    <>
      <div className="med-grid">
        {cells.map(([k, v]) => (
          <div key={k}>
            <small>{k}</small>
            <b>{v}</b>
          </div>
        ))}
      </div>
      <p className="med-reason">{m.reason}</p>
      {(m.attachments ?? []).length > 0 && (
        <div className="med-files">
          {(m.attachments ?? []).map((a) => (
            <button type="button" key={a.id + a.path} onClick={() => openFile(a.path)}>
              <span className="med-file-ext">{a.contentType === 'application/pdf' ? 'PDF' : 'IMG'}</span>
              <span>
                <b>{a.name}</b>
                <small>
                  {KIND_LABEL[a.kind]}
                  {a.byRole === 'medical' ? ' · by Medical Officer' : ''}
                </small>
              </span>
            </button>
          ))}
        </div>
      )}
      {m.stage === 'returned' && m.returnNote && (
        <div className="notice notice-error" style={{ marginTop: '0.8rem' }}>
          Returned by the {m.returnedBy ?? 'office'}: {m.returnNote}
        </div>
      )}
      <Downloads m={m} />
    </>
  );
}

export function ReviewCard({ m, me, startOpen }: { m: Med; me: Me; startOpen?: boolean }) {
  const isOffice = m.stage === 'office' && (m.officeEmail === me.email || me.admin);
  const roles = myRoles(m, me.email);
  const [role, setRole] = useState<SignRole | null>(roles[0] ?? null);
  const [open, setOpen] = useState(!!startOpen);
  const [note, setNote] = useState('');
  const [comment, setComment] = useState('');
  const [sig, setSig] = useState<Sig | null>(null);
  const [remember, setRemember] = useState(true);
  const [decision, setDecision] = useState<'approved' | 'not_approved'>('approved');
  const [certs, setCerts] = useState<Att[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const fileIn = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (roles.length) loadSignature(me.uid).then((s) => s && setSig((cur) => cur ?? s));
  }, [roles.length, me.uid]);
  useEffect(() => {
    if (!role || !roles.includes(role)) setRole(roles[0] ?? null);
  }, [roles.join(',')]);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setErr('');
    try {
      await fn();
      setNote('');
      setComment('');
      setCerts([]);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const sign = (decision: 'approved' | 'not_approved') => {
    if (!role) return;
    if (!sig) return setErr('Draw or upload your signature first.');
    if (decision === 'not_approved' && comment.trim().length < 3) return setErr('Add a comment saying why. It is printed on the form.');
    const next =
      role === 'medical'
        ? decision === 'approved'
          ? 'It will go to the HOD, Associate Dean and Joint Registrar.'
          : 'The request will be closed as not approved.'
        : 'Your stamp, comment and signature will be printed on the official form.';
    if (!confirm(`${decision === 'approved' ? 'Approve' : 'Not approve'} as ${ROLE_TITLE[role]}?\n\n${next}`)) return;
    run(decision, () =>
      act({ leaveId: m.id, action: 'sign', role, decision, comment: comment.trim() || undefined, signature: sig, saveSignature: remember, attachments: certs }),
    );
  };

  return (
    <div className="card med-card">
      <div className="med-card-head">
        <div>
          <strong>{m.studentName}</strong>
          <span className="med-soft">
            {m.refNo} · {prettyIso(m.fromDate)} – {prettyIso(m.toDate)} · {daysOf(m)} day{daysOf(m) === 1 ? '' : 's'}
          </span>
        </div>
        <StagePill m={m} />
      </div>
      <Flags m={m} />
      <Details m={m} />
      <button type="button" className="link-button med-toggle" onClick={() => setOpen((v) => !v)}>
        {open ? 'Hide signatures and history ▲' : 'Signatures and history ▼'}
      </button>
      {open && (
        <div className="med-open">
          <div>
            {ALL_ROLES.map((r) => (
              <SignRow key={r} m={m} r={r} />
            ))}
          </div>
          <History id={m.id} />
        </div>
      )}

      {err && <div className="notice notice-error">{err}</div>}

      {isOffice && (
        <div className="med-act">
          <h3>Office check</h3>
          <p className="med-soft">Check the student details, the {LATE_LIMIT_DAYS}-day rule and the enclosures. Forward it, or return it with a note.</p>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (needed to return, optional to forward)" maxLength={400} rows={2} />
          <div className="med-btns">
            <button
              type="button"
              disabled={!!busy}
              onClick={() => confirm(`Forward ${m.refNo} to ${m.medicalName ?? 'the Medical Officer'}?`) && run('forward', () => act({ leaveId: m.id, action: 'forward', note: note.trim() || undefined }))}
            >
              {busy === 'forward' ? 'Forwarding…' : 'Forward to Medical Officer'}
            </button>
            <button
              type="button"
              className="button-secondary"
              disabled={!!busy}
              onClick={() =>
                note.trim().length < 5
                  ? setErr('Write what the student should fix before returning.')
                  : confirm('Return this to the student?') && run('return', () => act({ leaveId: m.id, action: 'return', note: note.trim() }))
              }
            >
              {busy === 'return' ? 'Returning…' : 'Return to student'}
            </button>
          </div>
        </div>
      )}

      {role && (
        <div className="med-act">
          {roles.length > 1 && (
            <div className="med-roles">
              {roles.map((r) => (
                <button key={r} type="button" className={r === role ? '' : 'button-secondary'} onClick={() => setRole(r)}>
                  {ROLE_TITLE[r]}
                </button>
              ))}
            </div>
          )}
          <h3>Sign as {ROLE_TITLE[role]}</h3>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder={role === 'medical' ? 'Comment, e.g. Reports verified. Rest advised.' : 'Comment (needed if not approved)'}
            maxLength={400}
            rows={2}
          />
          {role === 'medical' && (
            <div className="med-certs">
              {certs.map((c) => (
                <span key={c.id} className="med-cert">
                  {c.name}
                  <button
                    type="button"
                    aria-label={`Remove ${c.name}`}
                    onClick={() => {
                      setCerts((p) => p.filter((x) => x.id !== c.id));
                      removeFile(c.path);
                    }}
                  >
                    ×
                  </button>
                </span>
              ))}
              <input
                ref={fileIn}
                type="file"
                accept="application/pdf,image/*"
                hidden
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (!f) return;
                  setBusy('upload');
                  try {
                    const a = await uploadCertificate(m, f);
                    setCerts((p) => [...p, a]);
                  } catch (x) {
                    setErr((x as Error).message);
                  } finally {
                    setBusy(null);
                  }
                }}
              />
              <button type="button" className="link-button" onClick={() => fileIn.current?.click()} disabled={busy === 'upload'}>
                {busy === 'upload' ? 'Uploading…' : '+ Attach verified medical certificate'}
              </button>
            </div>
          )}
          <div className="med-decide" role="radiogroup" aria-label="Your decision">
            {(['approved', 'not_approved'] as const).map((d) => (
              <button
                key={d}
                type="button"
                role="radio"
                aria-checked={decision === d}
                className={`med-decide-opt ${d === 'approved' ? 'ok' : 'no'}${decision === d ? ' on' : ''}`}
                onClick={() => setDecision(d)}
              >
                <StampMark decision={d} />
              </button>
            ))}
          </div>
          <SignaturePad value={sig} onChange={setSig} />
          <label className="med-remember">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Remember my signature
          </label>
          {sig && (
            <div className="med-preview">
              <span className="med-soft">On the form:</span>
              <StampMark decision={decision} at={new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })} />
              <SigSvg sig={sig} height={44} />
              <span className="med-soft">{me.name}, {ROLE_TITLE[role]}</span>
            </div>
          )}
          <div className="med-btns">
            <button type="button" className={decision === 'approved' ? 'med-approve' : 'med-reject'} disabled={!!busy} onClick={() => sign(decision)}>
              {busy === decision ? 'Signing…' : `${decision === 'approved' ? 'Approve' : 'Not approve'} & sign as ${ROLE_TITLE[role]}`}
            </button>
            {role === 'medical' && (
              <button
                type="button"
                className="button-secondary"
                disabled={!!busy}
                onClick={() =>
                  comment.trim().length < 5
                    ? setErr('Write in the comment what the student should add, then return.')
                    : confirm('Return to the student for more documents?') && run('return', () => act({ leaveId: m.id, action: 'return', note: comment.trim() }))
                }
              >
                Return for documents
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function Records({ list, me }: { list: Med[]; me: Me }) {
  const [q, setQ] = useState('');
  const [stage, setStage] = useState('all');
  const [branch, setBranch] = useState('all');
  const [month, setMonth] = useState('all');
  const [lateOnly, setLateOnly] = useState(false);
  const [view, setView] = useState<Med | null>(null);

  const branches = useMemo(() => Array.from(new Set(list.map((m) => m.branch).filter(Boolean) as string[])).sort(), [list]);
  const months = useMemo(() => Array.from(new Set(list.map((m) => m.fromDate.slice(0, 7)))).sort().reverse(), [list]);
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return list.filter((m) => {
      if (stage !== 'all') {
        if (stage === 'open' && ['teachers', 'done', 'rejected', 'withdrawn'].includes(m.stage)) return false;
        if (stage === 'approved' && !['teachers', 'done'].includes(m.stage)) return false;
        if (!['open', 'approved'].includes(stage) && m.stage !== stage) return false;
      }
      if (branch !== 'all' && m.branch !== branch) return false;
      if (month !== 'all' && !m.fromDate.startsWith(month)) return false;
      if (lateOnly && !m.late) return false;
      if (t && ![m.studentName, m.studentEnrollmentNumber, m.refNo, m.reason].some((x) => (x ?? '').toLowerCase().includes(t))) return false;
      return true;
    });
  }, [list, q, stage, branch, month, lateOnly]);
  const live = view ? list.find((m) => m.id === view.id) ?? view : null;

  const exportCsv = () => {
    const blob = new Blob(['﻿' + toCsv(shown)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `medical-leave-records-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  const stats = {
    total: list.length,
    open: list.filter((m) => !['teachers', 'done', 'rejected', 'withdrawn'].includes(m.stage)).length,
    approved: list.filter((m) => ['teachers', 'done'].includes(m.stage)).length,
    late: list.filter((m) => m.late).length,
  };

  return (
    <>
      <div className="med-stats">
        <div><small>Total</small><b>{stats.total}</b></div>
        <div><small>In progress</small><b>{stats.open}</b></div>
        <div><small>Approved</small><b>{stats.approved}</b></div>
        <div><small>Late</small><b>{stats.late}</b></div>
      </div>
      <div className="med-toolbar">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, reg. no. or ref. no." />
        <select value={stage} onChange={(e) => setStage(e.target.value)} aria-label="Status">
          <option value="all">All statuses</option>
          <option value="open">In progress</option>
          <option value="office">With office</option>
          <option value="medical">With Medical Officer</option>
          <option value="signoff">Awaiting signatures</option>
          <option value="returned">Returned</option>
          <option value="approved">Approved</option>
          <option value="rejected">Not approved</option>
          <option value="withdrawn">Withdrawn</option>
        </select>
        <select value={branch} onChange={(e) => setBranch(e.target.value)} aria-label="Branch">
          <option value="all">All branches</option>
          {branches.map((b) => (
            <option key={b}>{b}</option>
          ))}
        </select>
        <select value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month">
          <option value="all">All months</option>
          {months.map((mo) => (
            <option key={mo} value={mo}>
              {new Date(`${mo}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}
            </option>
          ))}
        </select>
        <label className="med-check">
          <input type="checkbox" checked={lateOnly} onChange={(e) => setLateOnly(e.target.checked)} /> Late only
        </label>
        <button type="button" className="button-secondary" onClick={exportCsv} disabled={!shown.length}>
          Export CSV ({shown.length})
        </button>
      </div>
      {shown.length === 0 ? (
        <div className="card med-empty">No records match.</div>
      ) : (
        <div className="card med-table-wrap">
          <table className="med-table">
            <thead>
              <tr>
                <th>Ref. No.</th>
                <th>Student</th>
                <th>Branch · Sem</th>
                <th>Absent</th>
                <th>Submitted</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((m) => (
                <tr key={m.id} onClick={() => setView(m)}>
                  <td className="mono">{m.refNo}</td>
                  <td>
                    <b>{m.studentName}</b>
                    <small>{m.studentEnrollmentNumber}</small>
                  </td>
                  <td>
                    {m.branch ?? '—'}
                    {m.semester ? ` · ${m.semester}` : ''}
                  </td>
                  <td>
                    {prettyIso(m.fromDate)} – {prettyIso(m.toDate)}
                    <small>{daysOf(m)} day{daysOf(m) === 1 ? '' : 's'}</small>
                  </td>
                  <td>
                    {stamp(m.submittedAt).split(',').slice(0, 1)}
                    {m.late && <small className="bad">LATE · {m.daysAfterRejoining}d</small>}
                  </td>
                  <td>
                    <StagePill m={m} />
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    {m.bundlePath ? (
                      <button type="button" className="link-button" onClick={() => openFile(m.bundlePath!)}>
                        Bundle
                      </button>
                    ) : m.formPdfPath ? (
                      <button type="button" className="link-button" onClick={() => openFile(m.formPdfPath!)}>
                        Form
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {live &&
        createPortal(
          <>
            <div className="drawer-overlay" onClick={() => setView(null)} />
            <div className="drawer-panel med-drawer" role="dialog" aria-label={`Medical leave ${live.refNo}`}>
              <button type="button" className="icon-button med-close" onClick={() => setView(null)} aria-label="Close">
                ×
              </button>
              <ReviewCard m={live} me={me} startOpen />
            </div>
          </>,
          document.body,
        )}
    </>
  );
}

export function MySignature({ me }: { me: Me }) {
  const [saved, setSaved] = useState<Sig | null | undefined>(undefined);
  const [draft, setDraft] = useState<Sig | null>(null);
  const [msg, setMsg] = useState('');
  useEffect(() => {
    loadSignature(me.uid).then(setSaved);
  }, [me.uid]);
  return (
    <div className="card" style={{ padding: '1.4rem 1.6rem', maxWidth: 640 }}>
      <h3 style={{ margin: '0 0 0.3rem' }}>Your signature</h3>
      <p className="med-soft" style={{ margin: '0 0 1rem' }}>
        Saved once, then filled in for you whenever you sign a medical leave form. You can still redraw it while signing.
      </p>
      {saved === undefined ? (
        <p className="med-soft">Loading…</p>
      ) : saved ? (
        <div className="med-saved">
          <SigSvg sig={saved} height={70} />
          <span className="med-soft">Current signature</span>
        </div>
      ) : (
        <p className="med-soft">No signature saved yet.</p>
      )}
      <SignaturePad value={draft} onChange={setDraft} />
      {msg && <div className="notice notice-ok">{msg}</div>}
      <div className="med-btns">
        <button
          type="button"
          disabled={!draft}
          onClick={async () => {
            if (!draft) return;
            await saveSignature(me.uid, me.name, draft);
            setSaved(draft);
            setDraft(null);
            setMsg('Signature saved.');
          }}
        >
          Save signature
        </button>
      </div>
    </div>
  );
}
