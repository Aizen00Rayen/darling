import type { BadgeTone } from '@/ui';
import type { UserStatus } from '@/shared';

const STATUS_LABELS: Record<UserStatus, string> = {
  invited: 'Invité',
  active: 'Actif',
  suspended: 'Suspendu',
  deactivated: 'Désactivé',
};
const STATUS_TONES: Record<UserStatus, BadgeTone> = {
  invited: 'warning',
  active: 'success',
  suspended: 'danger',
  deactivated: 'neutral',
};

export const statusLabel = (status: UserStatus): string => STATUS_LABELS[status];
export const statusTone = (status: UserStatus): BadgeTone => STATUS_TONES[status];

/** Own-property lookup so that values such as `constructor` are never mistaken for a known key. */
function lookup(map: Record<string, string>, key: string): string | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

const AUDIT_ACTIONS: Record<string, string> = {
  'user.created': 'Utilisateur créé',
  'user.updated': 'Utilisateur modifié',
  'user.suspended': 'Utilisateur suspendu',
  'user.reactivated': 'Utilisateur réactivé',
  'user.invite_resent': 'Invitation renvoyée',
  'user.sessions_revoked': 'Sessions révoquées',
  'setting.updated': 'Paramètre modifié',
  'order.status_changed': 'Statut de commande modifié',
  'order.notes_updated': 'Notes de commande modifiées',
  'order.created_manual': 'Commande saisie manuellement',
  'affiliate.profile_created': 'Profil influenceuse créé',
  'affiliate.manager_changed': 'Sous-manager modifié',
  'commission.validated': 'Commission validée',
  'commission.cancelled': 'Commission annulée',
  'commission.clawback': 'Commission déduite (retour)',
  'commission.hold_released': 'Commission libérée',
  'payout.created': 'Paiement enregistré',
  'auth.2fa_enabled': 'Double authentification activée',
  'auth.2fa_disabled': 'Double authentification désactivée',
  'auth.password_changed': 'Mot de passe modifié',
  'auth.invite_accepted': 'Invitation acceptée',
  'auth.password_reset': 'Mot de passe réinitialisé',
};

export function auditActionLabel(action: string): string {
  return lookup(AUDIT_ACTIONS, action) ?? action;
}

const LOGIN_REASONS: Record<string, string> = {
  ok: 'Connexion réussie',
  unknown_email: 'Adresse inconnue',
  bad_password: 'Mot de passe incorrect',
  locked: 'Compte verrouillé',
  inactive: 'Compte inactif',
  totp_required: 'Code requis',
  totp_invalid: 'Code invalide',
};

export function loginReasonLabel(reason: string | null): string {
  if (reason === null) return '—';
  return lookup(LOGIN_REASONS, reason) ?? reason;
}
