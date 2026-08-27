/**
 * The kleroterion plate. A slab, a channel down the left, three slot rows on
 * the right, the top slot drawn in brass.
 *
 * Inline rather than an <img> so it inherits the palette: the plate and the
 * undrawn slots use currentColor, which lets the nav, the footer and a dark
 * ground each render it correctly without three copies of the file. Only the
 * drawn slot is fixed, because brass means drawn and that is the one thing in
 * the mark that carries meaning.
 */
export function SortisMark({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 128 128"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Sortis"
    >
      <rect
        x="12"
        y="12"
        width="104"
        height="104"
        rx="8"
        fill="none"
        stroke="currentColor"
        strokeWidth="8"
      />
      <rect x="30" y="30" width="10" height="68" rx="2" fill="currentColor" />
      <rect x="56" y="32" width="38" height="14" rx="2" fill="var(--brass)" />
      <rect x="56" y="57" width="38" height="14" rx="2" fill="currentColor" />
      <rect x="56" y="82" width="38" height="14" rx="2" fill="currentColor" />
    </svg>
  );
}
