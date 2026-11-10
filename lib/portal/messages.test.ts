import { describe, expect, it } from 'vitest';
import { apiMessage, fieldErrorsOf } from './messages';

describe('apiMessage', () => {
  it.each([
    ['owner_required', 'Seul un propriétaire peut effectuer cette action.'],
    ['forbidden', 'Vous n’avez pas la permission d’effectuer cette action.'],
    ['last_owner', 'Il doit rester au moins un propriétaire actif.'],
    ['email_taken', 'Cette adresse e-mail est déjà utilisée.'],
    ['cannot_suspend_self', 'Vous ne pouvez pas suspendre votre propre compte.'],
    ['mail_failed', 'Le message n’a pas pu être envoyé. Réessayez.'],
    ['not_found', 'Introuvable.'],
    ['too_many_attempts', 'Trop de tentatives. Réessayez dans une minute.'],
    ['invalid_credentials', 'Mot de passe incorrect.'],
    ['totp_invalid', 'Code invalide ou déjà utilisé.'],
    ['2fa_required_for_role', 'La double authentification est obligatoire pour votre rôle.'],
  ])('%s', (code, text) => expect(apiMessage(code)).toBe(text));

  it('has a French message for every other expected code', () => {
    for (const code of ['not_invited', 'not_suspended', 'invalid_status', 'no_pending_setup', 'already_enabled', 'not_enabled', 'network']) {
      expect(apiMessage(code)).toMatch(/\S/);
      expect(apiMessage(code)).not.toBe(code);
    }
  });

  it('falls back to a generic message', () => {
    expect(apiMessage('???')).toBe('Une erreur est survenue. Réessayez.');
    expect(apiMessage('constructor')).toBe('Une erreur est survenue. Réessayez.');
  });
});

describe('fieldErrorsOf', () => {
  it('returns the API field errors, or an empty object', () => {
    expect(fieldErrorsOf({ ok: false, status: 400, code: 'validation', errors: { email: 'Invalide.' } })).toEqual({ email: 'Invalide.' });
    expect(fieldErrorsOf({ ok: false, status: 400, code: 'x' })).toEqual({});
  });
});
