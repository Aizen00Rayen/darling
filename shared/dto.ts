import { z } from 'zod';
import { PERMISSIONS } from './permissions';
import { PHONE_ERROR, normalizePhone } from './phone';
import { ROLES, USER_STATUSES } from './roles';

export const emailSchema = z
  .string({ error: 'Adresse e-mail requise.' })
  .trim()
  .toLowerCase()
  .pipe(z.email({ error: 'Adresse e-mail invalide.' }).max(254, 'Adresse e-mail trop longue.'));

/** Algerian mobile number, transformed to the normalised `0[567]xxxxxxxx` form. */
const phoneSchema = z
  .string({ error: PHONE_ERROR })
  .transform((value, ctx) => {
    const phone = normalizePhone(value);
    if (phone === null) {
      ctx.addIssue({ code: 'custom', message: PHONE_ERROR });
      return z.NEVER;
    }
    return phone;
  });

const roleSchema = z.enum(ROLES);
const permissionSchema = z.enum(PERMISSIONS);
const fullNameSchema = z
  .string({ error: 'Le nom est requis.' })
  .trim()
  .min(2, 'Le nom est requis.')
  .max(120, 'Le nom est trop long (120 caractères maximum).');

/** A password field the API judges itself (see passwordProblem): only bounded here. */
const passwordField = z
  .string({ error: 'Mot de passe requis.' })
  .min(1, 'Mot de passe requis.')
  .max(200, 'Le mot de passe est trop long.');
const tokenField = z.string({ error: 'Jeton requis.' }).min(1, 'Jeton requis.').max(500, 'Jeton invalide.');
const sixDigitCode = z.string({ error: 'Code à 6 chiffres requis.' }).regex(/^\d{6}$/, 'Code à 6 chiffres requis.');

export const meSchema = z.object({
  id: z.string(),
  email: z.string(),
  fullName: z.string(),
  role: roleSchema,
  isOwner: z.boolean(),
  permissions: z.array(permissionSchema),
  twoFactorEnabled: z.boolean(),
  mustEnroll2fa: z.boolean(),
});
export type Me = z.infer<typeof meSchema>;

export const userSchema = z.object({
  id: z.string(),
  email: z.string(),
  fullName: z.string(),
  phone: z.string().nullable(),
  role: roleSchema,
  status: z.enum(USER_STATUSES),
  isOwner: z.boolean(),
  permissions: z.array(permissionSchema),
  twoFactorEnabled: z.boolean(),
  lastLoginAt: z.string().nullable(),
  createdAt: z.string(),
});
export type User = z.infer<typeof userSchema>;

export const loginInput = z.object({
  email: emailSchema,
  password: passwordField,
  remember: z.boolean().optional(),
  totpCode: z.string().trim().min(1).max(32).optional(),
});
export type LoginInput = z.infer<typeof loginInput>;

export const createUserInput = z.object({
  email: emailSchema,
  fullName: fullNameSchema,
  phone: phoneSchema.optional(),
  role: roleSchema,
  permissions: z.array(permissionSchema).optional(),
  isOwner: z.boolean().optional(),
});
export type CreateUserInput = z.infer<typeof createUserInput>;

export const updateUserInput = z.object({
  fullName: fullNameSchema.optional(),
  phone: phoneSchema.optional(),
  role: roleSchema.optional(),
  permissions: z.array(permissionSchema).optional(),
  isOwner: z.boolean().optional(),
});
export type UpdateUserInput = z.infer<typeof updateUserInput>;

export const forgotPasswordInput = z.object({ email: emailSchema });
export type ForgotPasswordInput = z.infer<typeof forgotPasswordInput>;

export const passwordResetInput = z.object({ token: tokenField, password: passwordField });
export type PasswordResetInput = z.infer<typeof passwordResetInput>;

export const inviteAcceptInput = z.object({ token: tokenField, password: passwordField });
export type InviteAcceptInput = z.infer<typeof inviteAcceptInput>;

export const changePasswordInput = z.object({ currentPassword: passwordField, newPassword: passwordField });
export type ChangePasswordInput = z.infer<typeof changePasswordInput>;

/** Enabling needs the current password again: a stolen session cookie alone must not be able to enrol an authenticator. */
export const twoFactorEnableInput = z.object({ password: passwordField, code: sixDigitCode });
export type TwoFactorEnableInput = z.infer<typeof twoFactorEnableInput>;

export const twoFactorDisableInput = z.object({ password: passwordField, code: sixDigitCode });
export type TwoFactorDisableInput = z.infer<typeof twoFactorDisableInput>;

/** First-run setup form: the setup token from the server environment plus the first owner's details. */
export const setupInput = z.object({
  token: z.string({ error: 'Jeton de configuration requis.' }).min(1, 'Jeton de configuration requis.').max(500, 'Jeton invalide.'),
  fullName: fullNameSchema,
  email: emailSchema,
  password: passwordField,
});
export type SetupInput = z.infer<typeof setupInput>;

export const apiErrorSchema = z.object({
  code: z.string(),
  message: z.string().optional(),
  errors: z.record(z.string(), z.string()).optional(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
