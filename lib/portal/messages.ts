import type { ApiResult } from '../api/client';

const GENERIC = 'Une erreur est survenue. Réessayez.';

const MESSAGES: Record<string, string> = {
  owner_required: 'Seul un propriétaire peut effectuer cette action.',
  forbidden: 'Vous n’avez pas la permission d’effectuer cette action.',
  last_owner: 'Il doit rester au moins un propriétaire actif.',
  email_taken: 'Cette adresse e-mail est déjà utilisée.',
  cannot_suspend_self: 'Vous ne pouvez pas suspendre votre propre compte.',
  not_invited: 'Cet utilisateur n’a plus d’invitation en attente.',
  not_suspended: 'Cet utilisateur n’est pas suspendu.',
  invalid_status: 'Cette action n’est pas possible pour le statut actuel de l’utilisateur.',
  mail_failed: 'Le message n’a pas pu être envoyé. Réessayez.',
  not_found: 'Introuvable.',
  too_many_attempts: 'Trop de tentatives. Réessayez dans une minute.',
  invalid_credentials: 'Mot de passe incorrect.',
  totp_invalid: 'Code invalide ou déjà utilisé.',
  no_pending_setup: 'Aucune activation en cours. Recommencez l’activation.',
  already_enabled: 'La double authentification est déjà activée.',
  not_enabled: 'La double authentification n’est pas activée.',
  '2fa_required_for_role': 'La double authentification est obligatoire pour votre rôle.',
  network: 'Connexion impossible. Vérifiez votre réseau et réessayez.',
  validation: 'Certaines informations sont invalides.',
  unauthenticated: 'Votre session a expiré. Reconnectez-vous.',
};

/** French message for an API error code (generic fallback; own-property lookup only). */
export function apiMessage(code: string): string {
  return Object.hasOwn(MESSAGES, code) ? (MESSAGES[code] ?? GENERIC) : GENERIC;
}

/** Per-field messages of a `validation` failure (some are already French), else `{}`. */
export function fieldErrorsOf(result: Extract<ApiResult<unknown>, { ok: false }>): Record<string, string> {
  return result.errors ?? {};
}
