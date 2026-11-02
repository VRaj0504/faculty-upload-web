import type { ReactNode } from 'react';
import { Loading, useExamAccess } from './ExamCell';

export default function ExamCellGate({
  email,
  role,
  what,
  children,
}: {
  email: string;
  role: string | null;
  what: string;
  children: ReactNode;
}) {
  const access = useExamAccess(email, role);
  if (access.loading) return <Loading />;
  if (!access.full) {
    return (
      <div className="card" style={{ maxWidth: 560, margin: '3rem auto', padding: '1.8rem' }}>
        <h2 style={{ fontSize: '1.2rem', margin: '0 0 0.5rem' }}>Exam cell only</h2>
        <p style={{ margin: 0, color: 'var(--ink-soft)' }}>
          Only the exam cell and admins can change {what}. Ask the admin to add you to the exam cell if you need access.
        </p>
      </div>
    );
  }
  return <>{children}</>;
}
