-- 0007_no_mandatory_2fa: two-factor authentication is no longer required for any role.
-- The requirement setting is switched off (when it was stored), and every account's authenticator is cleared so that
-- nobody is asked for a code at login. Users may still enrol again voluntarily from "Mon compte" if they want to.
UPDATE settings SET value = 'false' WHERE key = 'security.require_2fa_super_managers';
UPDATE users SET totp_enabled = 0, totp_secret_enc = NULL, totp_last_step = NULL WHERE totp_enabled = 1 OR totp_secret_enc IS NOT NULL;
