import { useEffect, useMemo, useState } from 'react';
import { collection, deleteDoc, doc, getDoc, limit, onSnapshot, orderBy, query, serverTimestamp, writeBatch } from 'firebase/firestore';
import { auth, db } from './firebaseConfig';

// Admin page: posts students reported from the app (⋯ → Report post). Each new report also emails the
// moderators. Every report must be handled within 24 hours: remove the post, or dismiss the report.

const REASONS: Record<string, string> = {
  spam: 'Spam or misleading',
  harassment: 'Harassment or bullying',
  hate: 'Hate speech',
  sexual: 'Sexual or explicit content',
  violence: 'Violence or threats',
  false: 'False information',
  other: 'Something else',
};

type Report = {
  id: string;
  kind: 'notice' | 'event';
  contentId: string;
  title: string;
  authorName: string;
  clubName: string;
  reason: string;
  status: string;
  action: string;
  at: Date | null;
};
type Group = { key: string; kind: Report['kind']; contentId: string; title: string; authorName: string; clubName: string; reports: Report[]; first: Date | null };

const fmt = (d: Date | null) => (d ? d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '');
const collectionFor = (kind: Report['kind']) => (kind === 'event' ? 'clubEvents' : 'notices');

export default function ReportedPosts() {
  const [reports, setReports] = useState<Report[] | null>(null);
  const [show, setShow] = useState<'open' | 'handled'>('open');
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<Record<string, string>>({});
  const [err, setErr] = useState('');

  useEffect(
    () =>
      onSnapshot(
        query(collection(db, 'contentReports'), orderBy('createdAt', 'desc'), limit(300)),
        (snap) =>
          setReports(
            snap.docs.map((d) => {
              const x = d.data();
              return {
                id: d.id,
                kind: x.kind === 'event' ? 'event' : 'notice',
                contentId: String(x.contentId ?? ''),
                title: String(x.title ?? ''),
                authorName: String(x.authorName ?? ''),
                clubName: String(x.clubName ?? ''),
                reason: String(x.reason ?? ''),
                status: String(x.status ?? 'open'),
                action: String(x.action ?? ''),
                at: x.createdAt?.toDate ? x.createdAt.toDate() : null,
              };
            }),
          ),
        (e) => setErr(`Couldn't load reports: ${e.message}`),
      ),
    [],
  );

  const groups = useMemo(() => {
    const map = new Map<string, Group>();
    (reports ?? [])
      .filter((r) => (show === 'open' ? r.status === 'open' : r.status !== 'open'))
      .forEach((r) => {
        const key = `${r.kind}:${r.contentId}`;
        const g = map.get(key) ?? { key, kind: r.kind, contentId: r.contentId, title: r.title, authorName: r.authorName, clubName: r.clubName, reports: [], first: r.at };
        g.reports.push(r);
        if (r.at && (!g.first || r.at < g.first)) g.first = r.at;
        map.set(key, g);
      });
    return [...map.values()].sort((a, b) => (a.first?.getTime() ?? 0) - (b.first?.getTime() ?? 0));
  }, [reports, show]);

  const openCount = (reports ?? []).filter((r) => r.status === 'open').length;

  const close = async (g: Group, status: 'removed' | 'dismissed') => {
    const batch = writeBatch(db);
    g.reports
      .filter((r) => r.status === 'open')
      .forEach((r) =>
        batch.update(doc(db, 'contentReports', r.id), {
          status,
          action: status === 'removed' ? 'deleted' : 'none',
          resolvedBy: auth.currentUser?.email ?? '',
          resolvedAt: serverTimestamp(),
        }),
      );
    await batch.commit();
  };

  const remove = async (g: Group) => {
    if (!window.confirm(`Delete "${g.title}" for everyone? This can't be undone.`)) return;
    setBusy(g.key);
    setErr('');
    try {
      await deleteDoc(doc(db, collectionFor(g.kind), g.contentId));
      await close(g, 'removed');
    } catch (e) {
      setErr(`Couldn't remove: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const dismiss = async (g: Group) => {
    setBusy(g.key);
    setErr('');
    try {
      await close(g, 'dismissed');
    } catch (e) {
      setErr(`Couldn't dismiss: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const view = async (g: Group) => {
    if (preview[g.key] !== undefined) {
      setPreview(({ [g.key]: _, ...rest }) => rest);
      return;
    }
    const snap = await getDoc(doc(db, collectionFor(g.kind), g.contentId)).catch(() => null);
    setPreview((p) => ({ ...p, [g.key]: snap?.exists() ? String(snap.get('description') ?? '(no text)') : 'This post has already been deleted.' }));
  };

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
        <div>
          <h1 style={{ fontSize: '1.4rem', margin: 0 }}>Reported posts</h1>
          <p className="res-hint" style={{ margin: '0.2rem 0 0' }}>
            Club events and notices that students reported. Handle each one within 24 hours.
          </p>
        </div>
        <div className="att-field" style={{ flex: '0 0 auto' }}>
          <label htmlFor="rp-show">Show</label>
          <select id="rp-show" value={show} onChange={(e) => setShow(e.target.value as 'open' | 'handled')}>
            <option value="open">Waiting ({openCount})</option>
            <option value="handled">Handled</option>
          </select>
        </div>
      </div>
      {err && <p className="error-text">{err}</p>}

      <div className="card" style={{ padding: '1.2rem 1.4rem' }}>
        {reports === null ? (
          <p className="res-hint">Loading…</p>
        ) : groups.length === 0 ? (
          <p className="res-hint">{show === 'open' ? 'Nothing waiting. ' : 'No handled reports yet.'}</p>
        ) : (
          groups.map((g, i) => {
            const reasons = [...new Set(g.reports.map((r) => REASONS[r.reason] ?? r.reason))].join(', ');
            const overdue = show === 'open' && g.first && Date.now() - g.first.getTime() > 20 * 3600 * 1000;
            return (
              <div key={g.key} style={{ borderTop: i ? '1px solid var(--line)' : 'none', padding: '0.8rem 0' }}>
                <div style={{ display: 'flex', gap: '0.8rem', alignItems: 'flex-start', flexWrap: 'wrap' }}>
                  <div style={{ flex: '1 1 18rem', minWidth: 0 }}>
                    <div style={{ fontWeight: 700, color: 'var(--ink)', wordBreak: 'break-word' }}>{g.title || '(untitled)'}</div>
                    <div style={{ fontSize: '0.82rem', color: 'var(--ink-soft)', marginTop: 2 }}>
                      {[g.kind === 'event' ? 'Club event' : 'Notice', g.authorName && `by ${g.authorName}`, g.clubName].filter(Boolean).join(' · ')}
                    </div>
                    <div style={{ fontSize: '0.82rem', marginTop: 4 }}>
                      <b>{g.reports.length} report{g.reports.length > 1 ? 's' : ''}</b> · {reasons} · first {fmt(g.first)}
                      {overdue && <span style={{ color: 'var(--danger, #c0392b)', fontWeight: 700 }}> · due soon</span>}
                      {show === 'handled' && <span> · {g.reports[0].status === 'removed' ? 'post removed' : 'dismissed'}</span>}
                    </div>
                    {preview[g.key] !== undefined && (
                      <p style={{ margin: '0.5rem 0 0', padding: '0.6rem 0.8rem', background: 'var(--panel-bg)', borderRadius: 10, fontSize: '0.88rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                        {preview[g.key]}
                      </p>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                    <button type="button" className="button-secondary" onClick={() => view(g)}>
                      {preview[g.key] !== undefined ? 'Hide' : 'View post'}
                    </button>
                    {show === 'open' && (
                      <>
                        <button type="button" className="button-secondary" disabled={busy === g.key} onClick={() => dismiss(g)}>
                          Dismiss
                        </button>
                        <button type="button" disabled={busy === g.key} onClick={() => remove(g)} style={{ background: 'var(--danger, #c0392b)' }}>
                          Remove post
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
