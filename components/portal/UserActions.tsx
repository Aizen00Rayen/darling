'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Field, Notice } from '@/ui';
import type { User } from '@/shared';
import { api } from '@/lib/api/client';
import { apiMessage } from '@/lib/portal/messages';
import { ConfirmDialog } from './ConfirmDialog';
import { CopyField } from './CopyField';

type ActionKey = 'suspend' | 'reactivate' | 'resend-invite' | 'revoke-sessions';

type Spec = {
  title: string;
  confirm: string;
  tone: 'primary' | 'danger';
  success: (user: User) => string;
  description: string;
  reason?: boolean;
};

const SPECS: Record<ActionKey, Spec> = {
  suspend: {
    title: 'Suspendre cet utilisateur ?',
    confirm: 'Suspendre',
    tone: 'danger',
    description: 'Il ne pourra plus se connecter et ses sessions seront fermées.',
    success: () => 'Utilisateur suspendu.',
    reason: true,
  },
  reactivate: {
    title: 'Réactiver cet utilisateur ?',
    confirm: 'Réactiver',
    tone: 'primary',
    description: 'Il pourra de nouveau se connecter.',
    success: () => 'Utilisateur réactivé.',
  },
  'resend-invite': {
    title: 'Renvoyer l’invitation ?',
    confirm: 'Renvoyer',
    tone: 'primary',
    description: 'Un nouveau lien d’invitation sera envoyé et l’ancien cessera de fonctionner.',
    success: (u) => `Invitation renvoyée à ${u.email}.`,
  },
  'revoke-sessions': {
    title: 'Révoquer les sessions ?',
    confirm: 'Révoquer',
    tone: 'danger',
    description: 'Toutes les sessions ouvertes de cet utilisateur seront fermées : il devra se reconnecter.',
    success: () => 'Sessions révoquées.',
  },
};

type Props = { user: User; meId: string; meIsOwner: boolean };

export function UserActions({ user, meId, meIsOwner }: Props) {
  const router = useRouter();
  const [pending, setPending] = useState<ActionKey | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [inviteLink, setInviteLink] = useState<string | null>(null);

  // The API refuses these for non-owners (owner_required); the UI just does not offer them.
  if (user.role === 'super_manager' && !meIsOwner) {
    return <Notice tone="info">Seul un propriétaire peut modifier un Super Manager.</Notice>;
  }

  const isSelf = user.id === meId;
  const available: ActionKey[] = [];
  if ((user.status === 'active' || user.status === 'invited') && !isSelf) available.push('suspend');
  if (user.status === 'suspended') available.push('reactivate');
  if (user.status === 'invited') available.push('resend-invite');
  if (user.status === 'active' || user.status === 'suspended') available.push('revoke-sessions');

  function open(action: ActionKey) {
    setError(null);
    setDone(null);
    setInviteLink(null);
    setReason('');
    setPending(action);
  }

  async function run() {
    if (!pending || busy) return;
    const action = pending;
    const spec = SPECS[action];
    setBusy(true);
    const body = spec.reason && reason.trim() !== '' ? { reason: reason.trim() } : undefined;
    const result = await api<unknown>(`/api/users/${user.id}/${action}`, { method: 'POST', ...(body ? { body } : {}) });
    setBusy(false);
    setPending(null);
    if (!result.ok) {
      setError(apiMessage(result.code));
      return;
    }
    if (action === 'resend-invite' && result.data && typeof result.data === 'object' && 'link' in result.data) {
      setInviteLink(String((result.data as { link: unknown }).link));
      setDone('Nouveau lien d’invitation généré. Vous pouvez le copier directement ci-dessous :');
    } else {
      setDone(spec.success(user));
    }
    router.refresh();
  }

  const spec = pending ? SPECS[pending] : null;

  return (
    <div className="p-stack">
      {error ? <Notice tone="error">{error}</Notice> : null}
      {done ? <Notice tone="success">{done}</Notice> : null}
      {inviteLink ? (
        <div className="p-stack" style={{ marginTop: '8px' }}>
          <p className="p-lead" style={{ fontWeight: 600 }}>Lien d’invitation direct à copier et transmettre :</p>
          <CopyField label="Lien d’invitation" value={inviteLink} />
        </div>
      ) : null}
      {available.length === 0 ? (
        <p className="p-lead">Aucune action disponible pour cet utilisateur.</p>
      ) : (
        <div className="p-actions">
          {available.map((action) => (
            <Button key={action} variant={SPECS[action].tone === 'danger' ? 'danger' : 'ghost'} onClick={() => open(action)}>
              {{ suspend: 'Suspendre', reactivate: 'Réactiver', 'resend-invite': 'Renvoyer l’invitation', 'revoke-sessions': 'Révoquer les sessions' }[action]}
            </Button>
          ))}
        </div>
      )}
      <ConfirmDialog
        open={pending !== null}
        title={spec?.title ?? ''}
        confirmLabel={spec?.confirm ?? ''}
        tone={spec?.tone ?? 'primary'}
        busy={busy}
        onConfirm={run}
        onCancel={() => setPending(null)}
      >
        {spec ? <p className="p-lead">{spec.description}</p> : null}
        {spec?.reason ? (
          <div>
            <Field label="Motif (facultatif)">
              <textarea maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
          </div>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
