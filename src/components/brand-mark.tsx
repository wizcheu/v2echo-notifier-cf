import { useId } from "react";

/**
 * Web adaptation of the V2Echo BrandViolet app icon: white squircle with bottom
 * violet wash, #6C5CE7 V mark, and #8E7CF0 echo arcs.
 */
export function BrandMark({
  className,
  label,
}: {
  className?: string;
  label?: string;
}) {
  const gradientId = `brand-mark-wash-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <svg
      viewBox="0 0 1024 1024"
      className={className}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      <defs>
        <linearGradient id={gradientId} x1="0.5" y1="0.5" x2="0.5" y2="1">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0" />
          <stop offset="100%" stopColor="#6C5CE7" stopOpacity="0.2" />
        </linearGradient>
      </defs>
      <rect width="1024" height="1024" rx="240" fill="#ffffff" />
      <rect
        width="1024"
        height="1024"
        rx="240"
        fill={`url(#${gradientId})`}
      />
      <rect
        x="0.5"
        y="0.5"
        width="1023"
        height="1023"
        rx="239.5"
        fill="none"
        stroke="rgba(0, 0, 0, 0.07)"
        strokeWidth="1"
        vectorEffect="non-scaling-stroke"
      />
      <g
        fill="none"
        stroke="#8E7CF0"
        strokeWidth="24"
        strokeLinecap="round"
      >
        <path d="M 184 308 C 218 356 250 425 276 518" />
        <path d="M 154 370 C 184 413 205 458 222 498" />
        <path d="M 840 308 C 806 356 774 425 748 518" />
        <path d="M 870 370 C 840 413 819 458 802 498" />
      </g>
      <path
        d="M 380 240
           L 276 240
           C 250 240 234 266 244 291
           L 442 798
           C 453 828 481 848 512 848
           C 543 848 571 828 582 798
           L 780 291
           C 790 266 774 240 748 240
           L 644 240
           C 622 240 610 253 602 274
           L 526 515
           C 521 531 517 541 512 551
           C 507 541 503 531 498 515
           L 422 274
           C 414 253 402 240 380 240
           Z"
        fill="#6C5CE7"
      />
    </svg>
  );
}
