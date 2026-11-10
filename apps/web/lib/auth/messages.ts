/** French messages for the API error codes the authentication pages can meet. */
export const MESSAGES = {
  invalid_credentials: 'E-mail ou mot de passe incorrect.',
  too_many_attempts: 'Trop de tentatives. Réessayez dans une minute.',
  totp_invalid: 'Code invalide ou déjà utilisé. Attendez le prochain code et réessayez.',
  network: 'Connexion impossible. Vérifiez votre réseau et réessayez.',
  generic: 'Une erreur est survenue. Réessayez.',
  forgotNeutral: 'Si un compte existe pour cette adresse, un lien vient d’être envoyé.',
  mismatch: 'Les mots de passe ne correspondent pas.',
  invalidLink: 'Ce lien n’est plus valide.',
  resetDone: 'Mot de passe mis à jour. Vous pouvez vous connecter.',
  inviteDone: 'Compte activé. Vous pouvez vous connecter.',
  totpHint: 'Saisissez le code à 6 chiffres de votre application d’authentification.',
} as const;

export function messageForCode(code: string): string {
  switch (code) {
    case 'invalid_credentials':
      return MESSAGES.invalid_credentials;
    case 'too_many_attempts':
      return MESSAGES.too_many_attempts;
    case 'totp_invalid':
      return MESSAGES.totp_invalid;
    case 'network':
      return MESSAGES.network;
    default:
      return MESSAGES.generic;
  }
}
