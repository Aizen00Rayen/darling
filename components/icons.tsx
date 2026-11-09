import type { ReactNode } from 'react';

function Icon({ name, children }: { name: string; children: ReactNode }) {
  return (
    <svg
      className={`icon icon-${name}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const AsteriskIcon = () => (
  <Icon name="asterisk">
    <path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9" />
  </Icon>
);

export const ArrowIcon = () => (
  <Icon name="arrow">
    <path d="M6 18 18 6M6 6h12v12" />
  </Icon>
);

export const HeartIcon = () => (
  <Icon name="heart">
    <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z" />
  </Icon>
);

export const LeftIcon = () => (
  <Icon name="left">
    <path d="M19 12H5m6-6-6 6 6 6" />
  </Icon>
);

export const RightIcon = () => (
  <Icon name="right">
    <path d="M5 12h14m-6-6 6 6-6 6" />
  </Icon>
);
