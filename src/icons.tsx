// Lucide-style inline icons (stroke-width 1.5), ported from the mockup markup.
// Kept as plain components rather than an npm dependency since only a
// handful are used.
import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function base(size: number, props: IconProps) {
  const { size: _s, ...rest } = props;
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    ...rest,
  };
}

export function IconHome({ size = 18, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <polyline points="9 17 4 12 9 7"></polyline>
      <path d="M20 18v-2a4 4 0 0 0-4-4H4"></path>
    </svg>
  );
}

export function IconLabel({ size = 18, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"></path>
      <circle cx="7.5" cy="7.5" r="0.5"></circle>
    </svg>
  );
}

export function IconContacts({ size = 18, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path>
      <circle cx="9" cy="7" r="4"></circle>
      <path d="M22 21v-2a4 4 0 0 0-3-3.87"></path>
      <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
    </svg>
  );
}

export function IconSettings({ size = 18, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <line x1="21" x2="14" y1="4" y2="4"></line>
      <line x1="10" x2="3" y1="4" y2="4"></line>
      <line x1="21" x2="12" y1="12" y2="12"></line>
      <line x1="8" x2="3" y1="12" y2="12"></line>
      <line x1="21" x2="16" y1="20" y2="20"></line>
      <line x1="12" x2="3" y1="20" y2="20"></line>
      <line x1="14" x2="14" y1="2" y2="6"></line>
      <line x1="8" x2="8" y1="10" y2="14"></line>
      <line x1="16" x2="16" y1="18" y2="22"></line>
    </svg>
  );
}

export function IconSearch({ size = 15, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <circle cx="11" cy="11" r="8"></circle>
      <path d="m21 21-4.3-4.3"></path>
    </svg>
  );
}

export function IconChevronDown({ size = 14, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="m6 9 6 6 6-6"></path>
    </svg>
  );
}

export function IconChevronUp({ size = 14, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="m18 15-6-6-6 6"></path>
    </svg>
  );
}

export function IconChevronLeft({ size = 14, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="m12 19-7-7 7-7"></path>
      <path d="M19 12H5"></path>
    </svg>
  );
}

export function IconChevronRight({ size = 14, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="m9 18 6-6-6-6"></path>
    </svg>
  );
}

export function IconX({ size = 16, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M18 6 6 18"></path>
      <path d="m6 6 12 12"></path>
    </svg>
  );
}

export function IconCheck({ size = 14, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M20 6 9 17l-5-5"></path>
    </svg>
  );
}

export function IconPlus({ size = 14, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M5 12h14"></path>
      <path d="M12 5v14"></path>
    </svg>
  );
}

export function IconRefresh({ size = 13, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"></path>
      <path d="M21 3v5h-5"></path>
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"></path>
      <path d="M8 16H3v5"></path>
    </svg>
  );
}

export function IconMerge({ size = 14, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <circle cx="18" cy="18" r="3"></circle>
      <circle cx="6" cy="6" r="3"></circle>
      <path d="M6 21V9a9 9 0 0 0 9 9"></path>
    </svg>
  );
}

export function IconTrash({ size = 14, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M3 6h18"></path>
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path>
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path>
    </svg>
  );
}

export function IconPanel({ size = 16, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <rect width="18" height="18" x="3" y="3"></rect>
      <path d="M15 3v18"></path>
    </svg>
  );
}

export function IconNewTab({ size = 16, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M15 3h6v6"></path>
      <path d="M10 14 21 3"></path>
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
    </svg>
  );
}

export function IconCalendar({ size = 18, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <rect x="3" y="4" width="18" height="18" rx="2"></rect>
      <line x1="16" x2="16" y1="2" y2="6"></line>
      <line x1="8" x2="8" y1="2" y2="6"></line>
      <line x1="3" x2="21" y1="10" y2="10"></line>
    </svg>
  );
}
