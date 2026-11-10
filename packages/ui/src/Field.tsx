import { cloneElement, isValidElement, useId } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { cx } from './cx';

/** Props the control must receive so the label, hint and error are wired for assistive tech. */
export type FieldControlProps = {
  id: string;
  'aria-describedby'?: string;
  'aria-invalid'?: true;
};

export type FieldProps = {
  label: string;
  error?: string;
  hint?: string;
  /**
   * Either a render prop `(controlProps) => <input {...controlProps} />` (explicit, works with any
   * control or wrapper) or a single React element (`<input />`) onto which `id`, `aria-describedby`
   * and `aria-invalid` are injected. Anything else (text, fragments, arrays) is rendered untouched
   * and is NOT wired: use the render prop for those.
   */
  children: ReactElement<Record<string, unknown>> | ((props: FieldControlProps) => ReactNode);
};

export function Field({ label, error, hint, children }: FieldProps) {
  const uid = useId();
  const hintId = `${uid}-hint`;
  const errorId = `${uid}-error`;

  const ownId = isValidElement(children) ? (children.props.id as string | undefined) : undefined;
  const controlId = ownId ?? uid;

  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;
  const controlProps: FieldControlProps = {
    id: controlId,
    ...(describedBy ? { 'aria-describedby': describedBy } : {}),
    ...(error ? { 'aria-invalid': true as const } : {}),
  };

  let control: ReactNode;
  if (typeof children === 'function') control = children(controlProps);
  else if (isValidElement(children)) control = cloneElement(children, controlProps);
  else control = children;

  return (
    <div className={cx('dl-field', error && 'dl-field--invalid')}>
      <label className="dl-field__label" htmlFor={controlId}>
        {label}
      </label>
      {control}
      {hint ? (
        <p className="dl-field__hint" id={hintId}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="dl-field__error" id={errorId}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
