import type { ReactNode } from "react";

/** The interface's own line icons, drawn on a 16-unit grid and coloured by the text around them. */
const PATHS = {
  files: (
    <>
      <path d="M6 1.5h4.5l3 3v7H6z" />
      <path d="M10.5 1.5v3h3" />
      <path d="M6 4.5H2.5v10h7.5v-3" />
    </>
  ),
  search: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.4 10.4 14 14" />
    </>
  ),
  graph: (
    <>
      <circle cx="3.8" cy="4" r="1.8" />
      <circle cx="12.2" cy="5" r="1.8" />
      <circle cx="7" cy="12.2" r="1.8" />
      <path d="M5.6 4.2 10.4 4.8M4.5 5.7l1.8 4.8M11.2 6.5 8.1 10.8" />
    </>
  ),
  note: (
    <>
      <path d="M2.5 2.5h11v8.5H8l-3 2.5V11H2.5z" />
      <path d="M5 5.5h6M5 8h4" />
    </>
  ),
  pulse: <path d="M1.5 8.5h3l2-5 3 9 2-4h3" />,
  gear: (
    <>
      <circle cx="8" cy="8" r="5.3" strokeWidth="2.2" strokeDasharray="2.08 2.08" />
      <circle cx="8" cy="8" r="3.6" />
      <circle cx="8" cy="8" r="1.4" />
    </>
  ),
  "chevron-right": <path d="M6 3.5 10.5 8 6 12.5" />,
  "chevron-down": <path d="M3.5 6 8 10.5 12.5 6" />,
  close: <path d="m4 4 8 8M12 4l-8 8" />,
  target: (
    <>
      <circle cx="8" cy="8" r="4.5" />
      <path d="M8 1v3M8 12v3M1 8h3M12 8h3" />
      <circle cx="8" cy="8" r="0.6" />
    </>
  ),
  fit: <path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" />,
  reset: (
    <>
      <path d="M13 8.3a5 5 0 1 1-1.5-3.8" />
      <path d="M13.2 1.8v3.2H10" />
    </>
  ),
  "collapse-all": (
    <>
      <path d="M5.5 5.5v-3h8v8h-3" />
      <path d="M2.5 5.5h8v8h-8z" />
      <path d="M4.5 9.5h4" />
    </>
  ),
  copy: (
    <>
      <path d="M5.5 5.5h8v8h-8z" />
      <path d="M10.5 5.5v-3h-8v8h3" />
    </>
  ),
  check: <path d="m3 8.5 3.2 3L13 4.5" />,
  "side-left": (
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M6 2.5v11" />
    </>
  ),
  "side-right": (
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M10 2.5v11" />
    </>
  ),
  unfold: <path d="M8 6V1.5M5.8 3.6 8 1.4l2.2 2.2M8 10v4.5M5.8 12.4 8 14.6l2.2-2.2M3 8h10" />,
  fold: <path d="M8 1.5V6M5.8 3.9 8 6.1l2.2-2.2M8 14.5V10M5.8 12.1 8 9.9l2.2 2.2M3 8h10" />,
  orbit: (
    <>
      <ellipse cx="8" cy="8" rx="6.5" ry="2.8" />
      <circle cx="8" cy="8" r="1.6" />
    </>
  ),
  fly: <path d="M14 2 2 7l4.5 2L8 13.5z M6.5 9 14 2" />,
  palette: (
    <>
      <path d="M8 1.5a6.5 6.5 0 1 0 0 13c1.2 0 1.6-.9 1.1-1.8-.6-1 .1-2.2 1.3-2.2h1.4c1.5 0 2.7-1.2 2.7-2.7C14.500 4.300 11.600 1.500 8 1.500z" />
      <circle cx="5" cy="7" r="0.5" />
      <circle cx="7.5" cy="4.6" r="0.5" />
      <circle cx="10.6" cy="5.6" r="0.5" />
    </>
  ),
  glow: (
    <>
      <circle cx="8" cy="8" r="2.4" />
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
    </>
  ),
  warning: (
    <>
      <path d="M8 2 14.500 13.500h-13z" />
      <path d="M8 6.500v3.200M8 11.400v.3" />
    </>
  ),
  broadcast: (
    <>
      <circle cx="8" cy="8" r="1.4" />
      <path d="M4.800 11.200a4.500 4.500 0 0 1 0-6.400M11.200 4.800a4.500 4.500 0 0 1 0 6.400M2.700 13.300a7.500 7.500 0 0 1 0-10.600M13.300 2.700a7.500 7.500 0 0 1 0 10.600" />
    </>
  ),
  pin: (
    <path d="M9.500 1.800 14.200 6.500l-2 .5-2.400 2.400.2 3.100-1.400 1.400-3-3L2 14.500l3.600-3.600-3-3L4 6.500l3.100.2L9.500 4.300z" />
  ),
} as const;

export type GlyphName = keyof typeof PATHS;

export function Glyph({ name, size = 16 }: { name: GlyphName; size?: number }) {
  return (
    <svg
      className="glyph"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}

/** Vertskim's mark: three nodes of a graph, joined in a V. */
export function Logo({ size = 16 }: { size?: number }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 3.500 8 12.500 13 3.500" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <circle cx="3" cy="3.500" r="1.900" fill="var(--accent-bright)" />
      <circle cx="13" cy="3.500" r="1.900" fill="var(--accent-bright)" />
      <circle cx="8" cy="12.500" r="2.100" fill="currentColor" />
    </svg>
  );
}

/** A square button holding one icon, named for screen readers and in its tooltip. */
export function IconButton(props: {
  icon: GlyphName;
  label: string;
  onClick(): void;
  pressed?: boolean;
  disabled?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`icon-button${props.className ? ` ${props.className}` : ""}`}
      title={props.label}
      aria-label={props.label}
      aria-pressed={props.pressed}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <Glyph name={props.icon} />
      {props.children}
    </button>
  );
}
