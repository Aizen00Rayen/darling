import type { ButtonHTMLAttributes } from 'react';
import { cx } from './cx';

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'danger';
  /** Shows a spinner, disables the button and sets `aria-busy`. */
  busy?: boolean;
};

export function Button({ variant = 'primary', busy = false, className, type = 'button', disabled, children, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled || busy}
      aria-busy={busy ? true : undefined}
      className={cx('dl-btn', `dl-btn--${variant}`, className)}
    >
      {busy ? <span className="dl-spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}
