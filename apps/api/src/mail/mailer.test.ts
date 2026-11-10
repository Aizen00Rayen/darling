import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { memoryMailer, parseSmtpUrl, smtpMailer } from './mailer';

describe('memoryMailer', () => {
  it('records the mails it is asked to send, in order', async () => {
    const mailer = memoryMailer();
    expect(mailer.sent).toEqual([]);
    const a = { to: 'a@example.test', subject: 's1', text: 't1', html: 'h1' };
    const b = { to: 'b@example.test', subject: 's2', text: 't2', html: 'h2' };
    await mailer.send(a);
    await mailer.send(b);
    expect(mailer.sent).toEqual([a, b]);
  });
});

describe('parseSmtpUrl', () => {
  it('parses a plain localhost URL without requiring TLS', () => {
    expect(parseSmtpUrl('smtp://localhost:1025')).toEqual({
      host: 'localhost',
      port: 1025,
      secure: false,
    });
  });

  it('parses credentials (percent-decoded), smtps and the default ports', () => {
    expect(parseSmtpUrl('smtps://us%40er:p%3Ass@smtp.example.test:465')).toEqual({
      host: 'smtp.example.test',
      port: 465,
      secure: true,
      auth: { user: 'us@er', pass: 'p:ss' },
    });
    expect(parseSmtpUrl('smtp://smtp.example.test')).toMatchObject({ port: 587, secure: false });
    expect(parseSmtpUrl('smtps://smtp.example.test')).toMatchObject({ port: 465, secure: true });
  });

  it('rejects anything that is not an smtp(s) URL', () => {
    expect(() => parseSmtpUrl('http://localhost:1025')).toThrow();
    expect(() => parseSmtpUrl('nonsense')).toThrow();
  });
});

/** A minimal SMTP server that accepts one message and records what it received. */
function fakeSmtpServer() {
  const received: string[] = [];
  const server = net.createServer((socket) => {
    let inData = false;
    let buffer = '';
    socket.write('220 fake ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          received.push(buffer.slice(0, end));
          buffer = buffer.slice(end + 5);
          inData = false;
          socket.write('250 queued\r\n');
          continue;
        }
        const eol = buffer.indexOf('\r\n');
        if (eol === -1) return;
        const line = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO' || verb === 'HELO') socket.write('250 fake\r\n');
        else if (verb === 'DATA') {
          inData = true;
          socket.write('354 go\r\n');
        } else if (verb === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('250 ok\r\n');
      }
    });
  });
  return new Promise<{ port: number; received: string[]; close: () => Promise<void> }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      resolve({
        port,
        received,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

describe('smtpMailer', () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
  });

  it('delivers a multipart mail through a plain SMTP server', async () => {
    const smtp = await fakeSmtpServer();
    closers.push(smtp.close);
    const mailer = smtpMailer(`smtp://127.0.0.1:${smtp.port}`, 'DARLING* <no-reply@darling7.store>');
    await mailer.send({
      to: 'ines@example.test',
      subject: 'Bonjour',
      text: 'texte brut',
      html: '<p>html</p>',
    });
    expect(smtp.received).toHaveLength(1);
    const raw = smtp.received[0] as string;
    expect(raw).toContain('To: ines@example.test');
    expect(raw).toContain('no-reply@darling7.store');
    expect(raw).toContain('Subject: Bonjour');
    expect(raw).toContain('multipart/alternative');
    expect(raw).toContain('texte brut');
    expect(raw).toContain('<p>html</p>');
  });

  it('rejects when the server is unreachable', async () => {
    const mailer = smtpMailer('smtp://127.0.0.1:1', 'DARLING* <no-reply@darling7.store>');
    await expect(
      mailer.send({ to: 'a@example.test', subject: 's', text: 't', html: 'h' }),
    ).rejects.toThrow();
  });
});
