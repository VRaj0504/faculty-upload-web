import { useCallback, useEffect, useState } from 'react';
import { httpsCallable } from 'firebase/functions';
import { functions } from './firebaseConfig';
import { Icon, type IconName } from './icons';
import type { Tab } from './nav';

type Overview = {
  generatedAt: number;
  complaints: {
    open: number;
    openOver7Days: number;
    filedLast30: number;
    resolvedLast30: number;
    rejectedLast30: number;
    avgDaysToResolve: number | null;
    resolvedWithin3Days: number | null;
    byCategory: { category: string; total: number; open: number; resolved: number; rejected: number }[];
    oldestOpen: { subject: string; category: string; addressedTo: string; daysOpen: number }[];
  };
  sos: {
    active: { type: string; studentName: string; status: string; minutesAgo: number; responder: string | null }[];
    last30: number;
    resolvedLast30: number;
    avgResponseMinutes: number | null;
    recent: { type: string; status: string; at: number; responseMinutes: number | null; responder: string | null }[];
  };
};

const ago = (mins: number) => (mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : mins < 1440 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} d ago`);
const when = (ms: number) => new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) + ', ' + new Date(ms).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
const STATUS: Record<string, string> = { open: 'Waiting', acknowledged: 'On the way', resolved: 'Resolved' };

function Stat({ icon, label, value, sub, tone, onClick }: { icon: IconName; label: string; value: string | number; sub?: string; tone: string; onClick?: () => void }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag type={onClick ? 'button' : undefined} className={`do-stat${onClick ? ' is-link' : ''}`} onClick={onClick}>
      <span className="do-stat-icon" style={{ background: `var(--tone-${tone}-bg)`, color: `var(--tone-${tone}-fg)` }}>
        <Icon name={icon} size={18} />
      </span>
      <span className="do-stat-label">{label}</span>
      <span className="do-stat-value">{value}</span>
      {sub && <span className="do-stat-sub">{sub}</span>}
    </Tag>
  );
}

export default function DirectorDashboard({ onOpen }: { onOpen: (tab: Tab) => void }) {
  const [data, setData] = useState<Overview | null>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (force = false) => {
    setLoading(true);
    setErr('');
    try {
      const res = await httpsCallable<{ force: boolean }, Overview>(functions, 'getDirectorOverview', { timeout: 120000 })({ force });
      setData(res.data);
    } catch (e: any) {
      setErr(e?.code === 'functions/permission-denied' ? "This page is only for the Director's office." : `Couldn't load the overview: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (!data) {
    return (
      <div className="do-page">
        {err ? (
          <div className="card do-empty">
            <p className="error-text">{err}</p>
            <button type="button" onClick={() => load(true)}>Try again</button>
          </div>
        ) : (
          <div className="card do-empty"><p>Putting together the numbers…</p></div>
        )}
      </div>
    );
  }

  const c = data.complaints;
  const s = data.sos;

  return (
    <div className="do-page">
      <div className="do-head">
        <div>
          <h1>Complaints and SOS</h1>
          <p>Last 90 days · updated {new Date(data.generatedAt).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}</p>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button type="button" className="button-secondary" onClick={() => onOpen('meetings')}>Call a meeting</button>
          <button type="button" className="button-secondary" onClick={() => load(true)} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>
      {err && <p className="error-text">{err}</p>}

      <div className="do-stats">
        <Stat icon="chat" tone="blue" label="Open complaints" value={c.open} sub={`${c.filedLast30} filed in the last 30 days`} onClick={() => onOpen('complaints')} />
        <Stat icon="alert" tone={c.openOver7Days ? 'peach' : 'mint'} label="Waiting over 7 days" value={c.openOver7Days} sub={c.openOver7Days ? 'Needs attention' : 'Nothing stuck'} onClick={c.openOver7Days ? () => onOpen('complaints') : undefined} />
        <Stat
          icon="check"
          tone="mint"
          label="Average time to resolve"
          value={c.avgDaysToResolve === null ? '—' : `${c.avgDaysToResolve} d`}
          sub={c.resolvedWithin3Days === null ? 'No resolved complaints yet' : `${c.resolvedWithin3Days}% resolved within 3 days`}
        />
        <Stat icon="alert" tone={s.active.length ? 'pink' : 'mint'} label="Active SOS" value={s.active.length} sub={s.active.length ? 'Open the SOS board' : 'All clear'} onClick={() => onOpen('sos')} />
      </div>

      <div className="do-cols">
        <section className="card do-card">
          <div className="do-card-head">
            <h2>Complaint progress</h2>
            <span className="do-pill">{c.resolvedLast30} resolved · {c.rejectedLast30} rejected (30 days)</span>
          </div>
          <p className="do-note">Every complaint filed in the last 90 days, by category.</p>
          {c.byCategory.length === 0 ? (
            <p className="do-muted">No complaints filed.</p>
          ) : (
            <div className="do-table" role="table">
              <div className="do-tr do-cat do-th" role="row">
                <span>Category</span>
                <span className="do-num">Open</span>
                <span className="do-num">Resolved</span>
                <span className="do-num">Rejected</span>
              </div>
              {c.byCategory.map((g) => (
                <div className="do-tr do-cat" role="row" key={g.category}>
                  <span>
                    <b>{g.category}</b>
                    <small>{g.total} total</small>
                  </span>
                  <span className={`do-num${g.open ? ' warn' : ''}`}>{g.open}</span>
                  <span className="do-num">{g.resolved}</span>
                  <span className="do-num">{g.rejected}</span>
                </div>
              ))}
            </div>
          )}
          <p className="do-foot">Open the Complaints page to read individual complaints and see who is handling each.</p>
        </section>

        <section className="card do-card">
          <div className="do-card-head">
            <h2>Waiting the longest</h2>
            <button type="button" className="button-secondary" onClick={() => onOpen('complaints')}>See all</button>
          </div>
          {c.oldestOpen.length === 0 ? (
            <p className="do-note">No open complaints.</p>
          ) : (
            <ul className="do-list">
              {c.oldestOpen.map((o, i) => (
                <li key={i}>
                  <span className={`do-pill ${o.daysOpen > 7 ? 'bad' : o.daysOpen > 3 ? 'ok' : ''}`}>{o.daysOpen} d</span>
                  <span>
                    <b>{o.subject}</b>
                    <small>{o.category} · with {o.addressedTo}</small>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="card do-card">
        <div className="do-card-head">
          <h2>SOS</h2>
          <span className="do-pill">
            {s.last30} in 30 days · {s.resolvedLast30} resolved
            {s.avgResponseMinutes !== null ? ` · avg response ${s.avgResponseMinutes} min` : ''}
          </span>
        </div>
        {s.active.length > 0 && (
          <ul className="do-list">
            {s.active.map((a, i) => (
              <li key={i}>
                <span className="do-pill bad">{STATUS[a.status] ?? a.status}</span>
                <span>
                  <b>{a.type} · {a.studentName}</b>
                  <small>{ago(a.minutesAgo)}{a.responder ? ` · ${a.responder} responding` : ' · nobody has responded yet'}</small>
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="do-note">Recent alerts</p>
        {s.recent.length === 0 ? (
          <p className="do-muted">No SOS alerts in the last 90 days.</p>
        ) : (
          <ul className="do-list">
            {s.recent.map((a, i) => (
              <li key={i}>
                <span className="do-time" style={{ width: 118 }}>{when(a.at)}</span>
                <span>
                  <b>{a.type} · {STATUS[a.status] ?? a.status}</b>
                  <small>{a.responseMinutes === null ? 'No response recorded' : `Answered in ${a.responseMinutes} min by ${a.responder ?? 'a responder'}`}</small>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
