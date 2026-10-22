import { Suspense, useEffect, useState } from 'react';
import { lazyRetry } from './lazyRetry';
import BrandLoader from './BrandLoader';
import SegmentedControl from './SegmentedControl';
import { loadExamAccess, type ExamAccess } from './examData';

const ExamStatusBoard = lazyRetry(() => import('./ExamStatusBoard'));
const ResultUpload = lazyRetry(() => import('./ResultUpload'));
const ExamEvents = lazyRetry(() => import('./ExamEvents'));

type Mode = 'status' | 'results' | 'notices';

export default function ExamCell({ email, role }: { email: string; role: string | null }) {
  const [access, setAccess] = useState<ExamAccess>({ loading: true, full: false, examCell: false, hodBranches: [] });
  const [mode, setMode] = useState<Mode>('status');

  useEffect(() => {
    let alive = true;
    loadExamAccess(email, role).then((a) => alive && setAccess({ ...a, loading: false }));
    return () => {
      alive = false;
    };
  }, [email, role]);

  if (access.loading) {
    return (
      <div style={{ padding: '4rem 0' }}>
        <BrandLoader />
      </div>
    );
  }

  if (!access.full && access.hodBranches.length === 0) {
    return (
      <div className="card" style={{ maxWidth: 560, margin: '3rem auto', padding: '1.8rem' }}>
        <h2 style={{ fontSize: '1.2rem', margin: '0 0 0.5rem' }}>Exam cell only</h2>
        <p style={{ margin: 0, color: 'var(--ink-soft)' }}>
          Backlogs, results and exam registrations are open to the exam cell, admins and HODs (for their own branch). Ask the admin to
          add you to the exam cell if you need access.
        </p>
      </div>
    );
  }

  const options: { value: Mode; label: string }[] = access.full
    ? [
        { value: 'status', label: 'Student status' },
        { value: 'results', label: 'Upload results' },
        { value: 'notices', label: 'Notices & registration' },
      ]
    : [
        { value: 'status', label: 'Student status' },
        { value: 'notices', label: 'Registrations' },
      ];

  return (
    <div className="panel-enter">
      <div className="subtab-bar" style={{ paddingTop: '0.75rem' }}>
        <SegmentedControl<Mode> size="sm" options={options} value={mode} onChange={setMode} />
      </div>
      <Suspense fallback={<div style={{ padding: '4rem 0' }}><BrandLoader /></div>}>
        <div className="panel-enter" key={mode}>
          {mode === 'status' && <ExamStatusBoard branchesAllowed={access.full ? null : access.hodBranches} />}
          {mode === 'results' && access.full && <ResultUpload />}
          {mode === 'notices' && <ExamEvents canManage={access.full} hodBranches={access.hodBranches} />}
        </div>
      </Suspense>
    </div>
  );
}
