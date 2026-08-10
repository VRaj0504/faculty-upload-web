import { useLayoutEffect, useRef, useState } from 'react';

type Option<T extends string> = { value: T; label: string };

// A real segmented control: the accent pill is measured off the active
// button's actual position and width, then slides there with a spring —
// not three separate buttons swapping a background color. Reused for the
// main desk switcher and every Bulk Upload / Browse & Edit toggle so
// there's one implementation of "smooth tab switching" in the app, not
// three copies that could drift out of sync.
function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  size = 'md',
}: {
  options: Option<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: 'md' | 'sm';
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const measure = () => {
      const activeEl = container.querySelector<HTMLButtonElement>('[data-active="true"]');
      if (activeEl) {
        setIndicator({ left: activeEl.offsetLeft, width: activeEl.offsetWidth });
      }
    };

    measure();
    // Re-measure on resize/font-load — the labels are short but a late
    // web-font swap can still shift button widths by a few pixels.
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [value, options]);

  return (
    <div className={`segmented${size === 'sm' ? ' segmented-sm' : ''}`} ref={containerRef}>
      {indicator && (
        <div
          className="segmented-indicator"
          style={{ transform: `translateX(${indicator.left}px)`, width: indicator.width }}
        />
      )}
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            data-active={active}
            className={`segmented-option${active ? ' segmented-option-active' : ''}`}
            onClick={() => onChange(opt.value)}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

export default SegmentedControl;
