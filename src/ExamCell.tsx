import { Suspense, useEffect, useState } from 'react';
import { lazyRetry } from './lazyRetry';
import BrandLoader from './BrandLoader';
import { loadExamAccess, type ExamAccess } from './examData';

const ExamStatusBoard = lazyRetry(() => import('./ExamStatusBoard'));
const ResultUpload = lazyRetry(() => import('./ResultUpload'));
const ExamEvents = lazyRetry(() => import('./ExamEvents'));

export type ExamView = 'status' | 'results' | 'notices';

let cached: { key: string; access: Omit<ExamAccess, 'loading'> } | null = null;

export function useExamAccess(email: string, role: string | null): ExamAccess {
  const key = `${email}|${role}`;
  const [access, setAccess] = useState<ExamAccess>(
    cached?.key === key ? { ...cached.access, loading: false } : { loading: true, full: false, examCell: false, hodBranches: [] },
  );
  useEffect(() => {
    let alive = true;
    loadExamAccess(email, role).then((a) => {
      cached = { key, access: a };
      if (alive) setAccess({ ...a, loading: false });
    });
    return () => {
      alive = false;
    };
  }, [email, role, key]);
  return access;
}

const Loading = () => (
  <div style={{ padding: '4rem 0' }}>
    <BrandLoader />
  </div>
);

export default function ExamCell({ email, role, view }: { email: string; role: string | null; view: ExamView }) {
  const access = useExamAccess(email, role);

  if (access.loading) return <Loading />;

  const noAccess = !access.full && (access.hodBranches.length === 0 || view === 'results');
  if (noAccess) {
    return (
      <div className="card" style={{ maxWidth: 560, margin: '3rem auto', padding: '1.8rem' }}>
        <h2 style={{ fontSize: '1.2rem', margin: '0 0 0.5rem' }}>Exam cell only</h2>
        <p style={{ margin: 0, color: 'var(--ink-soft)' }}>
          {view === 'results'
            ? 'Only the exam cell and admins can upload official results.'
            : 'Backlogs and exam registrations are open to the exam cell, admins and HODs (for their own branch). Ask the admin to add you to the exam cell if you need access.'}
        </p>
      </div>
    );
  }

  return (
    <Suspense fallback={<Loading />}>
      {view === 'status' && <ExamStatusBoard branchesAllowed={access.full ? null : access.hodBranches} />}
      {view === 'results' && <ResultUpload />}
      {view === 'notices' && <ExamEvents canManage={access.full} hodBranches={access.hodBranches} />}
    </Suspense>
  );
}
