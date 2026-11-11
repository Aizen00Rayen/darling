import type { IpVerdict } from '@/server/diagnostics/diagnostics';

// French wording of the owner diagnostics page. Pure functions (tested); no server imports besides a type.

export function ipVerdictText(verdict: IpVerdict): { tone: 'success' | 'warning'; text: string } {
  return verdict === 'real'
    ? { tone: 'success', text: 'L’adresse IP réelle est détectée' }
    : {
        tone: 'warning',
        text: 'Attention : l’adresse détectée est locale/privée ou inconnue — les limites par IP seraient partagées entre tous les visiteurs',
      };
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return 'inconnu';
  if (bytes < 1024) return `${bytes} o`;
  const units = ['Ko', 'Mo', 'Go', 'To'];
  let value = bytes;
  let unit = -1;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1).replace('.', ',')} ${units[unit]}`;
}

export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} j ${h} h`;
  if (h > 0) return `${h} h ${m} min`;
  if (m > 0) return `${m} min ${s % 60} s`;
  return `${s} s`;
}

export function testMailFailureMessage(code: string, reason: string | undefined): string {
  if (code === 'smtp_not_configured') return 'Aucun serveur d’e-mail n’est configuré : renseignez SMTP_URL dans les variables d’environnement.';
  if (code === 'too_many_attempts') return 'Limite atteinte : 3 e-mails de test par heure.';
  if (code === 'forbidden') return 'Réservé au propriétaire.';
  if (code === 'mail_failed') {
    if (reason === 'EAUTH') return 'Le serveur d’e-mail a refusé les identifiants (utilisateur ou mot de passe de SMTP_URL).';
    if (reason === 'ECONNECTION' || reason === 'ETIMEDOUT' || reason === 'ESOCKET' || reason === 'ECONNREFUSED' || reason === 'EDNS') {
      return 'Impossible de joindre le serveur d’e-mail (vérifiez l’hôte et le port de SMTP_URL).';
    }
    return `L’envoi a échoué${reason ? ` (code ${reason})` : ''}. Vérifiez SMTP_URL.`;
  }
  return 'Une erreur est survenue. Réessayez.';
}

export function backupFailureMessage(code: string): string {
  if (code === 'backup_failed') return 'La sauvegarde n’a pas pu être créée. Vérifiez l’espace disque et les droits du dossier de données.';
  if (code === 'forbidden' || code === 'unauthenticated') return 'Réservé au propriétaire connecté.';
  return 'Une erreur est survenue. Réessayez.';
}
