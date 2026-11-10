// Structured logger. Rules (spec section 3): never serialise request bodies, cookies, tokens, hashes or SQL
// parameters. Sensitive keys are redacted at any depth; errors are logged as name + sanitised message + stack.

export type Level = 'info' | 'warn' | 'error';
type Fields = Record<string, unknown>;

const SENSITIVE_KEY = /password|token|cookie|secret|hash|authorization|set-cookie/i;
const REDACTED = '[REDACTED]';
const MAX_DEPTH = 8;

function serialiseError(err: Error, depth: number): Fields {
  const message = safeErrorMessage(err.message);
  const out: Fields = {
    name: err.name,
    message,
    stack: err.stack ? safeStack(err.stack, err.message, message) : undefined,
  };
  if (err.cause !== undefined && depth < 3) out.cause = errorToFields(err.cause, depth + 1);
  return out;
}

function errorToFields(err: unknown, depth = 0): Fields {
  if (err instanceof Error) return serialiseError(err, depth);
  return { name: 'NonError', message: safeErrorMessage(typeof err === 'string' ? err : safeString(err)) };
}

function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return '[unprintable]';
  }
}

const PARAMS_MARKER = /params:/i;
const SECRET_PAIR = /\b(password|passwd|token|secret|authorization|cookie|api[_-]?key)\b(\s*[=:]\s*)(?:Bearer\s+)?[^\s,;&'"]+/gi;

/** Cuts the text at the first `params:` marker (drivers append bound parameters there) and masks key=value secrets. */
export function safeErrorMessage(message: string): string {
  const at = message.search(PARAMS_MARKER);
  const cut = at === -1 ? message : `${message.slice(0, at).trimEnd()} [params omitted]`;
  return cut.replace(SECRET_PAIR, (_m, key: string, sep: string) => `${key}${sep}${REDACTED}`);
}

function safeStack(stack: string, rawMessage: string, safeMessage: string): string {
  // The stack repeats the message in its first lines; swap in the sanitised one, then scrub any other line.
  const replaced = rawMessage ? stack.split(rawMessage).join(safeMessage) : stack;
  return replaced
    .split('\n')
    .map((line) => safeErrorMessage(line))
    .join('\n');
}

/** Returns a JSON-safe deep copy with sensitive keys replaced. Never mutates the input. */
export function redact(value: unknown): unknown {
  return redactValue(value, new WeakSet(), 0);
}

function redactValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (typeof value !== 'object') return value;
  if (value instanceof Error) return redactValue(errorToFields(value), seen, depth);
  if (value instanceof Date) return value.toISOString();
  if (seen.has(value)) return '[Circular]';
  if (depth >= MAX_DEPTH) return '[MaxDepth]';
  seen.add(value);
  let out: unknown;
  if (Array.isArray(value)) {
    out = value.map((v) => redactValue(v, seen, depth + 1));
  } else {
    const obj: Fields = {};
    for (const [k, v] of Object.entries(value)) {
      obj[k] = SENSITIVE_KEY.test(k) ? REDACTED : redactValue(v, seen, depth + 1);
    }
    out = obj;
  }
  seen.delete(value); // only genuine cycles are marked, not repeated references
  return out;
}

export interface LoggerOptions {
  sink?: (level: Level, line: string) => void;
  now?: () => number;
}

export interface Logger {
  info(event: string, fields?: Fields): void;
  warn(event: string, fields?: Fields): void;
  error(event: string, fields?: Fields): void;
}

const defaultSink = (level: Level, line: string) => {
  (level === 'error' ? process.stderr : process.stdout).write(`${line}\n`);
};

export function createLogger(options: LoggerOptions = {}): Logger {
  const sink = options.sink ?? defaultSink;
  const now = options.now ?? Date.now;
  const emit = (level: Level, event: string, fields: Fields = {}) => {
    const rest = redact(fields) as Fields;
    for (const reserved of ['level', 'at', 'event']) delete rest[reserved]; // fields cannot overwrite these
    sink(level, JSON.stringify({ level, at: new Date(now()).toISOString(), event, ...rest }));
  };
  return {
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
  };
}

export const log: Logger = createLogger();

/** Logs an error as { name, message, stack } with bound parameters and secrets removed. */
export function logError(event: string, err: unknown, fields: Fields = {}, logger: Logger = log): void {
  logger.error(event, { ...fields, err: errorToFields(err) });
}
