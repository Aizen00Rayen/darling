import { Fragment } from 'react';

/** Renders strings separated by line breaks. */
export function Lines({ lines }: { lines: string[] }) {
  return (
    <>
      {lines.map((line, i) => (
        <Fragment key={line}>
          {i > 0 && <br />}
          {line}
        </Fragment>
      ))}
    </>
  );
}
