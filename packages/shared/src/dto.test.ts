import { describe, expect, it } from 'vitest';
import {
  apiErrorSchema,
  changePasswordInput,
  createUserInput,
  emailSchema,
  forgotPasswordInput,
  inviteAcceptInput,
  loginInput,
  meSchema,
  passwordResetInput,
  twoFactorDisableInput,
  twoFactorEnableInput,
  updateUserInput,
  userSchema,
} from './dto';

describe('emailSchema', () => {
  it('trims and lower-cases', () => {
    expect(emailSchema.parse('  Owner@Darling.DZ ')).toBe('owner@darling.dz');
  });
  it('rejects invalid and over-long addresses', () => {
    expect(emailSchema.safeParse('nope').success).toBe(false);
    expect(emailSchema.safeParse(`${'a'.repeat(250)}@x.dz`).success).toBe(false);
  });
});

describe('loginInput', () => {
  it('accepts the minimal and the full form', () => {
    expect(loginInput.parse({ email: ' A@B.dz ', password: 'x' })).toEqual({ email: 'a@b.dz', password: 'x' });
    expect(loginInput.parse({ email: 'a@b.dz', password: 'x', remember: true, totpCode: '123456' })).toEqual({
      email: 'a@b.dz',
      password: 'x',
      remember: true,
      totpCode: '123456',
    });
  });
  it('rejects an empty password', () => {
    expect(loginInput.safeParse({ email: 'a@b.dz', password: '' }).success).toBe(false);
  });
});

describe('createUserInput / updateUserInput', () => {
  const base = { email: 'N@D.dz', fullName: 'Nour A', role: 'sub_manager' } as const;

  it('creates with optional phone, permissions and owner flag', () => {
    expect(createUserInput.parse(base)).toEqual({ ...base, email: 'n@d.dz' });
    expect(
      createUserInput.parse({ ...base, phone: '+213 6 12 34 56 78', permissions: ['audit.read'], isOwner: false }),
    ).toMatchObject({ phone: '0612345678', permissions: ['audit.read'], isOwner: false });
  });

  it('rejects an invalid phone with a French message', () => {
    const result = createUserInput.safeParse({ ...base, phone: '0812345678' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['phone']);
      expect(result.error.issues[0]?.message).toMatch(/numéro/);
    }
  });

  it('rejects unknown roles and permissions', () => {
    expect(createUserInput.safeParse({ ...base, role: 'god' }).success).toBe(false);
    expect(createUserInput.safeParse({ ...base, permissions: ['nope'] }).success).toBe(false);
  });

  it('update has every field optional and no email', () => {
    expect(updateUserInput.parse({})).toEqual({});
    expect(updateUserInput.parse({ phone: '0712345678', role: 'affiliate' })).toEqual({
      phone: '0712345678',
      role: 'affiliate',
    });
    expect('email' in updateUserInput.shape).toBe(false);
    expect(updateUserInput.safeParse({ phone: 'abc' }).success).toBe(false);
  });
});

describe('password inputs', () => {
  it('reset and invite accept take token + password', () => {
    expect(passwordResetInput.parse({ token: 't', password: 'p' })).toEqual({ token: 't', password: 'p' });
    expect(inviteAcceptInput.parse({ token: 't', password: 'p' })).toEqual({ token: 't', password: 'p' });
    expect(passwordResetInput.safeParse({ token: '', password: 'p' }).success).toBe(false);
  });

  it('does not judge password strength (the API does) but bounds length', () => {
    expect(passwordResetInput.safeParse({ token: 't', password: 'abc' }).success).toBe(true);
    expect(passwordResetInput.safeParse({ token: 't', password: '' }).success).toBe(false);
    expect(passwordResetInput.safeParse({ token: 't', password: 'x'.repeat(201) }).success).toBe(false);
    expect(changePasswordInput.safeParse({ currentPassword: 'a', newPassword: 'x'.repeat(201) }).success).toBe(false);
  });

  it('change password needs both fields', () => {
    expect(changePasswordInput.parse({ currentPassword: 'a', newPassword: 'b' })).toEqual({
      currentPassword: 'a',
      newPassword: 'b',
    });
    expect(changePasswordInput.safeParse({ currentPassword: 'a' }).success).toBe(false);
  });
});

describe('two factor and forgot password inputs', () => {
  it('enable needs the current password and a 6-digit code', () => {
    expect(twoFactorEnableInput.parse({ password: 'p', code: '123456' })).toEqual({ password: 'p', code: '123456' });
    expect(twoFactorEnableInput.safeParse({ password: 'p', code: '12345' }).success).toBe(false);
    expect(twoFactorEnableInput.safeParse({ password: 'p', code: 'abcdef' }).success).toBe(false);
    expect(twoFactorEnableInput.safeParse({ code: '123456' }).success).toBe(false);
    expect(twoFactorEnableInput.safeParse({ password: '', code: '123456' }).success).toBe(false);
    expect(twoFactorEnableInput.safeParse({ password: 'x'.repeat(201), code: '123456' }).success).toBe(false);
  });
  it('disable needs password and code', () => {
    expect(twoFactorDisableInput.parse({ password: 'p', code: '123456' })).toEqual({ password: 'p', code: '123456' });
    expect(twoFactorDisableInput.safeParse({ password: 'p', code: '1' }).success).toBe(false);
  });
  it('forgot password normalises the email', () => {
    expect(forgotPasswordInput.parse({ email: ' X@Y.dz ' })).toEqual({ email: 'x@y.dz' });
  });
});

describe('response schemas', () => {
  const me = {
    id: 'u1',
    email: 'a@b.dz',
    fullName: 'A',
    role: 'super_manager',
    isOwner: true,
    permissions: ['audit.read'],
    twoFactorEnabled: false,
    mustEnroll2fa: true,
  };
  it('parses me', () => {
    expect(meSchema.parse(me)).toEqual(me);
  });
  it('parses user with nullable fields', () => {
    const user = {
      id: 'u1',
      email: 'a@b.dz',
      fullName: 'A',
      phone: null,
      role: 'affiliate',
      status: 'invited',
      isOwner: false,
      permissions: [],
      twoFactorEnabled: false,
      lastLoginAt: null,
      createdAt: '2026-11-10T10:00:00.000Z',
    };
    expect(userSchema.parse(user)).toEqual(user);
  });
  it('parses api errors', () => {
    expect(apiErrorSchema.parse({ code: 'validation', errors: { email: 'x' } })).toEqual({
      code: 'validation',
      errors: { email: 'x' },
    });
    expect(apiErrorSchema.safeParse({ message: 'no code' }).success).toBe(false);
  });
});
