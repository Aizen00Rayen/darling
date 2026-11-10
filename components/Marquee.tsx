import { AsteriskIcon } from './icons';

function Group({ text }: { text: string }) {
  return (
    <span className="marquee-group">
      {text} <AsteriskIcon /> {text} <AsteriskIcon /> {text} <AsteriskIcon />
    </span>
  );
}

/** Two identical groups keep the ticker seamless at every width. */
export function Marquee({ text }: { text: string }) {
  return (
    <div className="marquee" aria-hidden="true">
      <div className="marquee-track">
        <Group text={text} />
        <Group text={text} />
      </div>
    </div>
  );
}
