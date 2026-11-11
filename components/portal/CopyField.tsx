'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/ui';

type Props = {
  label: string;
  value: string;
};

/** A read-only text (a code, a link) with a copy button; "Copié" confirms for two seconds. Falls back to selecting the text. */
export function CopyField({ label, value }: Props) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    setFailed(false);
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // No clipboard permission (or an insecure origin): select the text so Ctrl+C works.
      input.current?.select();
      setFailed(true);
    }
  }

  return (
    <div className="p-copy">
      <input ref={input} type="text" readOnly value={value} aria-label={label} onFocus={(e) => e.currentTarget.select()} />
      <Button variant="ghost" onClick={copy} aria-label={`Copier : ${label}`}>
        {copied ? 'Copié' : 'Copier'}
      </Button>
      <span className="p-copy__status" role="status" aria-live="polite">
        {failed ? 'Copie impossible : sélectionnez le texte et copiez-le.' : ''}
      </span>
    </div>
  );
}
