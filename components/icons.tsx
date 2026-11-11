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

export const PlusIcon = () => (
  <Icon name="plus">
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

export const PackageIcon = () => (
  <Icon name="package">
    <path d="m16.5 9.4-9-5.19M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
    <path d="M3.27 6.96 12 12.01l8.73-5.05M12 22.08V12" />
  </Icon>
);

export const UsersIcon = () => (
  <Icon name="users">
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
  </Icon>
);

export const SparklesIcon = () => (
  <Icon name="sparkles">
    <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z" />
  </Icon>
);

export const ClockIcon = () => (
  <Icon name="clock">
    <circle cx="12" cy="12" r="10" />
    <polyline points="12 6 12 12 16 14" />
  </Icon>
);

export const CheckCircleIcon = () => (
  <Icon name="check-circle">
    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
    <polyline points="22 4 12 14.01 9 11.01" />
  </Icon>
);

export const TrendingUpIcon = () => (
  <Icon name="trending-up">
    <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" />
    <polyline points="17 6 23 6 23 12" />
  </Icon>
);

export const EyeIcon = () => (
  <Icon name="eye">
    <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
    <circle cx="12" cy="12" r="3" />
  </Icon>
);
