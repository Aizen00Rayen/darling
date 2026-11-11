import { describe, expect, it } from 'vitest';
import { backupFailureMessage, formatBytes, formatDuration, ipVerdictText, testMailFailureMessage } from './diagnostics';

describe('ipVerdictText', () => {
  it('says the real address is detected', () => {
    expect(ipVerdictText('real')).toEqual({ tone: 'success', text: 'L’adresse IP réelle est détectée' });
  });
  it('warns about local, private or unknown addresses', () => {
    expect(ipVerdictText('local_or_unknown')).toEqual({
      tone: 'warning',
      text: 'Attention : l’adresse détectée est locale/privée ou inconnue — les limites par IP seraient partagées entre tous les visiteurs',
    });
  });
});

describe('formatBytes', () => {
  it('uses French units', () => {
    expect(formatBytes(null)).toBe('inconnu');
    expect(formatBytes(0)).toBe('0 o');
    expect(formatBytes(1023)).toBe('1023 o');
    expect(formatBytes(2048)).toBe('2,0 Ko');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5,0 Mo');
    expect(formatBytes(3.5 * 1024 ** 3)).toBe('3,5 Go');
  });
});

describe('formatDuration', () => {
  it('shows the two most significant units', () => {
    expect(formatDuration(45)).toBe('45 s');
    expect(formatDuration(125)).toBe('2 min 5 s');
    expect(formatDuration(3 * 3600 + 120)).toBe('3 h 2 min');
    expect(formatDuration(2 * 86400 + 5 * 3600)).toBe('2 j 5 h');
  });
});

describe('failure messages', () => {
  it('maps API codes to French sentences and never echoes raw data', () => {
    expect(testMailFailureMessage('smtp_not_configured', undefined)).toMatch(/SMTP_URL/);
    expect(testMailFailureMessage('too_many_attempts', undefined)).toMatch(/3 e-mails de test par heure/);
    expect(testMailFailureMessage('mail_failed', 'EAUTH')).toMatch(/identifiants/);
    expect(testMailFailureMessage('mail_failed', 'ECONNECTION')).toMatch(/serveur/);
    expect(testMailFailureMessage('mail_failed', 'WHATEVER')).toMatch(/WHATEVER/);
    expect(backupFailureMessage('backup_failed')).toMatch(/n’a pas pu être créée/);
    expect(backupFailureMessage('forbidden')).toMatch(/propriétaire/);
  });
});
