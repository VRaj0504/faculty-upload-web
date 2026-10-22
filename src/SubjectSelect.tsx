import { useEffect, useState } from 'react';
import { subjectsFor } from './curriculum';

export default function SubjectSelect({
  branch,
  semester,
  code,
  name,
  onChange,
  disabled,
}: {
  branch: string;
  semester: number | string | null;
  code: string;
  name: string;
  onChange: (next: { code: string; name: string }) => void;
  disabled?: boolean;
}) {
  const options = branch && semester ? subjectsFor(branch, Number(semester)) : [];
  const matched = options.find((o) => o.code === code) ?? (!code ? options.find((o) => o.name === name) : undefined);
  const [other, setOther] = useState(false);
  useEffect(() => setOther(false), [branch, semester]);
  const typing = !!(branch && semester) && (other || options.length === 0 || (!!(code || name) && !matched));

  return (
    <div>
      <select
        disabled={disabled || !branch || !semester}
        value={typing ? '__other__' : matched?.code ?? ''}
        onChange={(e) => {
          if (e.target.value === '__other__') {
            setOther(true);
            onChange({ code: '', name: '' });
            return;
          }
          setOther(false);
          const chosen = options.find((o) => o.code === e.target.value);
          onChange(chosen ? { code: chosen.code, name: chosen.name } : { code: '', name: '' });
        }}
      >
        <option value="">{branch && semester ? 'Select a subject…' : 'Pick branch and semester first'}</option>
        {options.map((o) => (
          <option key={o.code} value={o.code}>{o.code} — {o.name}</option>
        ))}
        {branch && semester && <option value="__other__">Other / elective (type it)</option>}
      </select>
      {typing && (
        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
          <input style={{ width: 110 }} placeholder="Code" value={code} onChange={(e) => onChange({ code: e.target.value, name })} />
          <input style={{ flex: 1 }} placeholder="Subject name" value={name} onChange={(e) => onChange({ code, name: e.target.value })} />
        </div>
      )}
    </div>
  );
}
