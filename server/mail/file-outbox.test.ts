import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildMailer } from '../context';
import { fileOutboxMailer, readOutbox } from './file-outbox';
import { memoryMailer } from './mailer';

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'darling-outbox-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const mail = {
  to: 'aya@example.test',
  subject: 'Bienvenue',
  text: 'Activez : http://localhost:3100/invitation?token=abc123 puis http://localhost:3100/connexion.',
  html: '<p>x</p>',
};

describe('fileOutboxMailer', () => {
  it('writes one JSON file per mail with to, subject, text and the links, and still delegates', async () => {
    const dir = path.join(tmp(), 'nested', 'outbox');
    const inner = memoryMailer();
    const mailer = fileOutboxMailer(dir, inner, () => 1_700_000_000_000);
    await mailer.send(mail);
    await mailer.send({ ...mail, to: 'b@example.test' });
    expect(inner.sent).toHaveLength(2);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(2);
    expect(fs.readdirSync(dir).some((f) => f.endsWith('.tmp'))).toBe(false);
    const entries = readOutbox(dir);
    expect(entries.map((e) => e.to)).toEqual(['aya@example.test', 'b@example.test']);
    expect(entries[0]).toMatchObject({
      subject: 'Bienvenue',
      text: mail.text,
      links: ['http://localhost:3100/invitation?token=abc123', 'http://localhost:3100/connexion'],
    });
    expect(JSON.stringify(entries[0])).not.toContain('<p>');
  });

  it('readOutbox returns [] for a missing directory and ignores foreign files', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
    fs.writeFileSync(path.join(dir, 'broken.json'), '{nope');
    expect(readOutbox(dir)).toEqual([]);
    expect(readOutbox(path.join(dir, 'missing'))).toEqual([]);
  });

  it('a failure of the inner mailer surfaces after the file is written', async () => {
    const dir = tmp();
    const mailer = fileOutboxMailer(dir, { send: async () => Promise.reject(new Error('smtp down')) });
    await expect(mailer.send(mail)).rejects.toThrow('smtp down');
    expect(readOutbox(dir)).toHaveLength(1);
  });
});

describe('buildMailer with mailOutboxDir', () => {
  const base = { nodeEnv: 'development' as const, smtpUrl: undefined, mailFrom: undefined };

  it('wraps the console mailer outside production', async () => {
    const dir = tmp();
    const lines: string[] = [];
    const m = buildMailer({ ...base, mailOutboxDir: dir }, (_l, e, f) => lines.push(JSON.stringify({ e, ...f })));
    await m.send(mail);
    expect(readOutbox(dir)).toHaveLength(1);
    expect(lines.join('')).toContain('mail.dev_not_sent');
  });

  it('refuses to be built in production, even when handed the directory directly', () => {
    expect(() => buildMailer({ ...base, nodeEnv: 'production', mailOutboxDir: tmp() })).toThrow(/MAIL_OUTBOX_DIR/);
  });

  it('is unchanged when no directory is configured', async () => {
    const lines: string[] = [];
    const m = buildMailer({ ...base, mailOutboxDir: undefined }, (_l, e) => lines.push(e));
    await m.send(mail);
    expect(lines).toEqual(['mail.dev_not_sent']);
  });
});
