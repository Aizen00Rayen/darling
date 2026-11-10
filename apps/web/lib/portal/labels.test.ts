import { describe, expect, it } from 'vitest';
import { auditActionLabel, loginReasonLabel, statusLabel, statusTone } from './labels';

describe('statusLabel / statusTone', () => {
  it('uses the French status names', () => {
    expect(statusLabel('invited')).toBe('Invité');
    expect(statusLabel('active')).toBe('Actif');
    expect(statusLabel('suspended')).toBe('Suspendu');
    expect(statusLabel('deactivated')).toBe('Désactivé');
  });
  it('maps statuses to badge tones', () => {
    expect(statusTone('active')).toBe('success');
    expect(statusTone('invited')).toBe('warning');
    expect(statusTone('suspended')).toBe('danger');
    expect(statusTone('deactivated')).toBe('neutral');
  });
});

describe('auditActionLabel', () => {
  it.each([
    ['user.created', 'Utilisateur créé'],
    ['user.suspended', 'Utilisateur suspendu'],
    ['setting.updated', 'Paramètre modifié'],
    ['auth.2fa_enabled', 'Double authentification activée'],
    ['auth.password_reset', 'Mot de passe réinitialisé'],
  ])('%s -> %s', (action, label) => expect(auditActionLabel(action)).toBe(label));

  it('falls back to the raw action for unknown values', () => {
    expect(auditActionLabel('something.new')).toBe('something.new');
  });

  it('does not treat Object prototype keys as known actions', () => {
    expect(auditActionLabel('constructor')).toBe('constructor');
    expect(auditActionLabel('__proto__')).toBe('__proto__');
  });
});

describe('loginReasonLabel', () => {
  it('labels known reasons and falls back to the raw value', () => {
    expect(loginReasonLabel('ok')).toBe('Connexion réussie');
    expect(loginReasonLabel('bad_password')).toBe('Mot de passe incorrect');
    expect(loginReasonLabel('totp_invalid')).toBe('Code invalide');
    expect(loginReasonLabel('weird')).toBe('weird');
    expect(loginReasonLabel(null)).toBe('—');
  });
});
