export type Config = {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  appOrigin: string;
  databaseUrl: string;
  databaseOwnerUrl: string;
  cookieSecure: boolean;
  trustProxy: boolean;
  encryptionKey: Buffer;
  tokenPepper: Buffer;
  smtpUrl: string;
  mailFrom: string;
};

type Env = Record<string, string | undefined>;
type Problems = string[];

// Validators report a reason per key. Reasons are fixed strings: a rejected value
// (which may be a secret or contain credentials) is never echoed.

function oneOf<T extends string>(env: Env, key: string, allowed: readonly T[], problems: Problems): T {
  const value = env[key];
  if (value !== undefined && (allowed as readonly string[]).includes(value)) return value as T;
  problems.push(`${key} must be one of: ${allowed.join(', ')}`);
  return allowed[0] as T;
}

function port(env: Env, key: string, problems: Problems): number {
  const value = env[key];
  if (value !== undefined && /^\d{1,5}$/.test(value)) {
    const n = Number(value);
    if (n >= 1 && n <= 65535) return n;
  }
  problems.push(`${key} must be an integer between 1 and 65535`);
  return 0;
}

function boolean(env: Env, key: string, problems: Problems): boolean {
  const value = env[key];
  if (value === 'true') return true;
  if (value === 'false') return false;
  problems.push(`${key} must be exactly "true" or "false"`);
  return false;
}

function parseUrl(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function urlWithProtocol(env: Env, key: string, protocols: readonly string[], problems: Problems): string {
  const value = env[key];
  const url = parseUrl(value);
  if (value && url && protocols.includes(url.protocol)) return value;
  problems.push(`${key} must be a valid URL starting with ${protocols.map((p) => `${p}//`).join(' or ')}`);
  return '';
}

function origin(env: Env, key: string, problems: Problems): string {
  const url = parseUrl(env[key]);
  if (url && (url.protocol === 'http:' || url.protocol === 'https:')) return url.origin;
  problems.push(`${key} must be an http(s) origin such as https://example.com`);
  return '';
}

function key32(env: Env, key: string, problems: Problems): Buffer {
  const value = env[key];
  if (value && /^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    const bytes = Buffer.from(value, 'base64');
    if (bytes.length === 32 && bytes.toString('base64') === value) return bytes;
  }
  problems.push(`${key} must be base64 that decodes to exactly 32 bytes (openssl rand -base64 32)`);
  return Buffer.alloc(0);
}

function nonEmpty(env: Env, key: string, problems: Problems): string {
  const value = env[key];
  if (value !== undefined && value.trim() !== '') return value;
  problems.push(`${key} must not be empty`);
  return '';
}

export function loadConfig(env: Env): Config {
  const problems: Problems = [];
  const config: Config = {
    nodeEnv: oneOf(env, 'NODE_ENV', ['development', 'test', 'production'], problems),
    port: port(env, 'API_PORT', problems),
    appOrigin: origin(env, 'APP_ORIGIN', problems),
    databaseUrl: urlWithProtocol(env, 'DATABASE_URL', ['postgres:', 'postgresql:'], problems),
    databaseOwnerUrl: urlWithProtocol(env, 'DATABASE_OWNER_URL', ['postgres:', 'postgresql:'], problems),
    cookieSecure: boolean(env, 'COOKIE_SECURE', problems),
    trustProxy: boolean(env, 'TRUST_PROXY', problems),
    encryptionKey: key32(env, 'ENCRYPTION_KEY', problems),
    tokenPepper: key32(env, 'TOKEN_PEPPER', problems),
    smtpUrl: urlWithProtocol(env, 'SMTP_URL', ['smtp:', 'smtps:'], problems),
    mailFrom: nonEmpty(env, 'MAIL_FROM', problems),
  };
  if (problems.length > 0) {
    throw new Error(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }
  return config;
}
