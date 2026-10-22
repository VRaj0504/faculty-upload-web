// The portal's loader: the CollegeGo logo floating gently while its mint
// "go" dot sends out a soft ping — the same loader the student app uses.
export default function BrandLoader({ label = 'Loading…', large = false }: { label?: string; large?: boolean }) {
  return (
    <div className={`brand-loader${large ? ' brand-loader-lg' : ''}`} role="status" aria-live="polite">
      <div className="bl-stage" aria-hidden="true">
        <img className="bl-logo" src="/logo.svg" alt="" />
        <span className="bl-ping" />
        <span className="bl-dot" />
      </div>
      <p className="bl-label">{label}</p>
    </div>
  );
}
