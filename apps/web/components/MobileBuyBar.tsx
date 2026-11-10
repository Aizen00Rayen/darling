'use client';

import { useEffect, useState } from 'react';
import { ArrowIcon } from './icons';

type Props = { name: string; price: string; shadeCode: string; formId: string };

/** Sticky buy bar shown below 700 px; slides away while the order form is on screen. */
export function MobileBuyBar({ name, price, shadeCode, formId }: Props) {
  const [inForm, setInForm] = useState(false);

  useEffect(() => {
    const form = document.getElementById(formId);
    if (!form) return;
    const observer = new IntersectionObserver(([entry]) => setInForm(entry.isIntersecting), {
      threshold: 0.05,
    });
    observer.observe(form);
    return () => observer.disconnect();
  }, [formId]);

  return (
    <div className={`mobile-buy glass${inForm ? ' in-form' : ''}`}>
      <div>
        <b>{name.toUpperCase()}</b>
        <span>
          {price} · <span>{shadeCode}</span>
        </span>
      </div>
      <a href={`#${formId}`}>
        COMMANDER <ArrowIcon />
      </a>
    </div>
  );
}
