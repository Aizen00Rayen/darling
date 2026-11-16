'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api/client';
import { apiMessage } from '@/lib/portal/messages';

/** Inline editor for a product's real purchase cost (finance only). Saves on blur or Enter. */
export function CostEditor({ productId, value }: { productId: string; value: number }) {
  const router = useRouter();
  const [v, setV] = useState(String(value));
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | string>('idle');

  async function save() {
    const n = Number(v);
    if (v.trim() === '' || !Number.isInteger(n) || n < 0) {
      setState('Montant invalide');
      return;
    }
    if (n === value) return;
    setState('saving');
    const result = await api('/api/stock/cost', { method: 'POST', body: { productId, costPrice: n } });
    if (!result.ok) {
      setState(apiMessage(result.code));
      return;
    }
    setState('saved');
    router.refresh();
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <input
        type="number"
        min={0}
        step={1}
        inputMode="numeric"
        aria-label="Prix d’achat unitaire en dinars"
        value={v}
        onChange={(e) => {
          setV(e.target.value);
          setState('idle');
        }}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void save();
          }
        }}
        style={{ width: 96, height: 34, borderRadius: 10, border: '1px solid var(--line)', padding: '0 8px', background: '#fff' }}
      />
      <small aria-live="polite" style={{ color: state === 'saved' ? 'var(--success-ink)' : 'var(--danger)' }}>
        {state === 'saved' ? '✓' : state === 'saving' || state === 'idle' ? '' : state}
      </small>
    </span>
  );
}
