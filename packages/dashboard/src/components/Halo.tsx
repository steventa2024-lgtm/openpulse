import type { JSX } from 'react';
import { useId } from 'react';

/** The OpenPulse halo mark. Same drawing as assets/brand/halo-mark.svg. */
export function HaloMark({ className, size }: { className?: string; size?: number }): JSX.Element {
  const id = useId().replace(/:/g, '');
  const ring = `halo-ring-${id}`;
  const inner = `halo-inner-${id}`;
  const glow = `halo-glow-${id}`;
  return (
    <svg
      className={className}
      viewBox="0 0 128 128"
      fill="none"
      width={size}
      height={size}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={ring} x1="22" y1="20" x2="106" y2="108" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#38BDF8" />
          <stop offset="0.5" stopColor="#6366F1" />
          <stop offset="1" stopColor="#A855F7" />
        </linearGradient>
        <linearGradient id={inner} x1="100" y1="28" x2="46" y2="88" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ECFEFF" />
          <stop offset="0.35" stopColor="#67E8F9" />
          <stop offset="0.75" stopColor="#6366F1" stopOpacity="0.55" />
          <stop offset="1" stopColor="#7C3AED" stopOpacity="0.15" />
        </linearGradient>
        <filter id={glow} x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="6" />
        </filter>
      </defs>
      <circle
        cx="64"
        cy="64"
        r="42"
        stroke={`url(#${ring})`}
        strokeWidth="10"
        opacity="0.85"
        filter={`url(#${glow})`}
      />
      <circle
        cx="72"
        cy="57"
        r="31"
        stroke="#67E8F9"
        strokeWidth="6"
        opacity="0.45"
        filter={`url(#${glow})`}
      />
      <circle cx="64" cy="64" r="42" stroke={`url(#${ring})`} strokeWidth="7" />
      <circle cx="72" cy="57" r="31" stroke={`url(#${inner})`} strokeWidth="4.5" />
    </svg>
  );
}
