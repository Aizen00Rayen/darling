import { AsteriskIcon } from './icons';

function Group() {
  return (
    <span className="marquee-group">
      WET LIPS. BIG CRUSH. <AsteriskIcon /> WET LIPS. BIG CRUSH. <AsteriskIcon /> WET LIPS. BIG CRUSH.{' '}
      <AsteriskIcon />
    </span>
  );
}

/** Two identical groups keep the ticker seamless at every width. */
export function Marquee() {
  return (
    <div className="marquee" aria-hidden="true">
      <div className="marquee-track">
        <Group />
        <Group />
      </div>
    </div>
  );
}
