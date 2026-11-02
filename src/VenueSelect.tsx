import { useState } from 'react';
import { VENUES } from './examVenues';

export default function VenueSelect({
  value,
  onChange,
  className,
  style,
}: {
  value: string;
  onChange: (v: string) => void;
  className?: string;
  style?: React.CSSProperties;
}) {
  const known = (VENUES as readonly string[]).includes(value);
  const [other, setOther] = useState(!!value && !known);
  const showOther = other || (!!value && !known);
  return (
    <>
      <select
        className={className}
        style={style}
        value={showOther ? '__other__' : value}
        onChange={(e) => {
          if (e.target.value === '__other__') {
            setOther(true);
            if (known) onChange('');
            return;
          }
          setOther(false);
          onChange(e.target.value);
        }}
      >
        <option value="">Venue…</option>
        {VENUES.map((v) => (
          <option key={v} value={v}>{v}</option>
        ))}
        <option value="__other__">Other…</option>
      </select>
      {showOther && (
        <input
          className={className}
          style={{ ...style, marginTop: 4 }}
          placeholder="Venue"
          value={known ? '' : value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </>
  );
}
