import { useState } from 'react';
import type { ExamEntry } from './examSheetParser';
import ExamGrid from './ExamGrid';
import ExamEntriesTable from './ExamEntriesTable';
import SegmentedControl from './SegmentedControl';
import { subjectsFor } from './curriculum';
import { branchesOf } from './examSheetParser';

type View = 'grid' | 'list';
const KEY = 'examEditorView';
const readView = (): View => {
  try {
    return localStorage.getItem(KEY) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
};

export default function ExamEditor({
  entries,
  onChange,
  branch,
  semester,
  examType,
  problemRows,
  onRowEdited,
}: {
  entries: ExamEntry[];
  onChange: (next: ExamEntry[]) => void;
  branch: string;
  semester: string;
  examType?: string;
  problemRows?: number[];
  onRowEdited?: (rowNumber: number) => void;
}) {
  const [view, setView] = useState<View>(readView);
  const choose = (v: View) => {
    setView(v);
    try {
      localStorage.setItem(KEY, v);
    } catch {

    }
  };

  const listSubjects = (() => {
    const seen = new Map<string, string>();
    for (const b of branchesOf(branch)) for (const s of subjectsFor(b, Number(semester))) if (!seen.has(s.code)) seen.set(s.code, s.name);
    return Array.from(seen, ([code, name]) => ({ code, name }));
  })();

  return (
    <div style={{ marginTop: '0.9rem' }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <SegmentedControl<View>
          size="sm"
          options={[
            { value: 'grid', label: 'Grid' },
            { value: 'list', label: 'List' },
          ]}
          value={view}
          onChange={choose}
        />
      </div>
      {view === 'grid' ? (
        <ExamGrid entries={entries} onChange={onChange} branch={branch} semester={semester} examType={examType} />
      ) : (
        <ExamEntriesTable entries={entries} onChange={onChange} problemRows={problemRows} onRowEdited={onRowEdited} subjects={listSubjects} />
      )}
    </div>
  );
}
