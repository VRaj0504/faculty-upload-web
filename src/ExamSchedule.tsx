import { useState } from 'react';
import SegmentedControl from './SegmentedControl';
import ExamPdfAttach from './ExamPdfAttach';
import ExamScheduleManual from './ExamScheduleManual';
import ExamWholeCollegeImport from './ExamWholeCollegeImport';

function ExamSchedule() {
  const [mode, setMode] = useState<'pdf' | 'manual' | 'wholeCollege'>('pdf');

  return (
    <div className="card" style={{ width: 960, maxWidth: '100%', padding: '2.5rem', margin: '3rem auto' }}>
      <h1 style={{ fontSize: '1.5rem' }}>Exam Date Sheet</h1>

      <div className="subtab-bar" style={{ marginTop: '1rem' }}>
        <SegmentedControl<'pdf' | 'manual' | 'wholeCollege'>
          size="sm"
          options={[
            { value: 'pdf', label: 'Attach PDF' },
            { value: 'manual', label: 'Excel / Manual (one class)' },
            { value: 'wholeCollege', label: 'Excel (whole college)' },
          ]}
          value={mode}
          onChange={setMode}
        />
      </div>

      <div style={{ marginTop: '1rem' }}>
        {mode === 'pdf' ? <ExamPdfAttach /> : mode === 'manual' ? <ExamScheduleManual /> : <ExamWholeCollegeImport />}
      </div>
    </div>
  );
}

export default ExamSchedule;
