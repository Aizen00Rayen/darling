'use client';

import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { Button } from '@darling/ui';

type Props = {
  open: boolean;
  title: string;
  confirmLabel: string;
  tone?: 'primary' | 'danger';
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children?: ReactNode;
};

/**
 * Modal confirmation on a native <dialog>: the browser traps focus, closes on Escape and gives focus
 * back to the button that opened it.
 */
export function ConfirmDialog({ open, title, confirmLabel, tone = 'primary', busy = false, onConfirm, onCancel, children }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="p-dialog"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onCancel();
      }}
      onClose={() => {
        if (open) onCancel();
      }}
    >
      <div className="p-dialog__body">
        <h2 className="p-dialog__title" id={titleId}>
          {title}
        </h2>
        {children}
        <div className="p-form__actions">
          <Button variant={tone} busy={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={onCancel}>
            Annuler
          </Button>
        </div>
      </div>
    </dialog>
  );
}
