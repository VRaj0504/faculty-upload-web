// The portal's loader: the "IS" mark breathing inside a spinning arc, with
// three soft dots — the same loader the student app uses.
export default function BrandLoader({ label = 'Loading…', large = false }: { label?: string; large?: boolean }) {
  return (
    <div className={`brand-loader${large ? ' brand-loader-lg' : ''}`} role="status" aria-live="polite">
      <div className="bl-ring">
        <span className="bl-track" />
        <span className="bl-arc" />
        <span className="bl-mark">IS</span>
      </div>
      <p className="bl-label">{label}</p>
      <div className="bl-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}
