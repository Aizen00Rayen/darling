import { createServer, type Server } from 'node:net';
import { describe, expect, it } from 'vitest';
import { consoleMailer, memoryMailer, parseSmtpUrl, smtpMailer } from './mailer';

const mail = { to: 'a@example.test', subject: 'Sujet', text: 'Lien : http://localhost:3000/invitation?token=abc', html: '<p>x</p>' };

describe('memoryMailer', () => {
  it('records the mails it is asked to send, in order', async () => {
    const m = memoryMailer();
    await m.send(mail);
    await m.send({ ...mail, to: 'b@example.test' });
    expect(m.sent.map((x) => x.to)).toEqual(['a@example.test', 'b@example.test']);
  });
});

describe('parseSmtpUrl', () => {
  it('uses opportunistic STARTTLS for loopback hosts', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]', '127.5.5.5']) {
      const o = parseSmtpUrl(`smtp://${host}:1025`);
      expect(o).toMatchObject({ port: 1025, secure: false, requireTLS: false });
      expect(o.auth).toBeUndefined();
    }
  });

  it('REQUIRES TLS for any other host unless the URL says otherwise', () => {
    expect(parseSmtpUrl('smtp://smtp.hostinger.com:587')).toMatchObject({ host: 'smtp.hostinger.com', port: 587, secure: false, requireTLS: true });
    expect(parseSmtpUrl('smtp://mail.example.test')).toMatchObject({ port: 587, requireTLS: true });
    expect(parseSmtpUrl('smtp://10.0.0.5:25')).toMatchObject({ requireTLS: true });
    expect(parseSmtpUrl('smtp://smtp.example.test:25?starttls=optional')).toMatchObject({ requireTLS: false });
    expect(parseSmtpUrl('smtp://localhost:1025?starttls=required')).toMatchObject({ requireTLS: true });
  });

  it('parses credentials (percent-decoded), smtps and the default ports', () => {
    expect(parseSmtpUrl('smtp://us%40er:p%3Ass@smtp.example.test:2525')).toMatchObject({
      host: 'smtp.example.test',
      port: 2525,
      secure: false,
      auth: { user: 'us@er', pass: 'p:ss' },
    });
    expect(parseSmtpUrl('smtps://smtp.example.test')).toMatchObject({ port: 465, secure: true });
    expect(parseSmtpUrl('smtps://localhost')).toMatchObject({ port: 465, secure: true });
  });

  it('sets connection 10 s, greeting 10 s and socket 20 s timeouts', () => {
    expect(parseSmtpUrl('smtp://localhost:1025')).toMatchObject({ connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 });
  });

  it('rejects anything that is not an smtp(s) URL, without echoing credentials', () => {
    for (const bad of ['', 'not a url', 'http://localhost:1025', 'ftp://x', 'smtp://', 'smtp://localhost:99999', 'smtp://localhost?starttls=maybe']) {
      expect(() => parseSmtpUrl(bad), bad).toThrow();
    }
    try {
      parseSmtpUrl('http://user:topsecret@localhost');
    } catch (e) {
      expect(String(e)).not.toContain('topsecret');
    }
  });
});

describe('consoleMailer', () => {
  it('logs the link and subject but never the address, and sends nothing', async () => {
    const lines: string[] = [];
    const m = consoleMailer((_level, event, fields) => lines.push(JSON.stringify({ event, ...fields })));
    await m.send(mail);
    const log = lines.join('');
    expect(log).toContain('http://localhost:3000/invitation?token=abc');
    expect(log).not.toContain('a@example.test');
  });
});

describe('smtpMailer', () => {
  async function fakeSmtp(): Promise<{ port: number; messages: string[]; close(): Promise<void> }> {
    const messages: string[] = [];
    const server: Server = createServer((socket) => {
      let data = false;
      let buffer = '';
      socket.write('220 test ESMTP\r\n');
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        if (data) {
          if (buffer.includes('\r\n.\r\n')) {
            messages.push(buffer);
            buffer = '';
            data = false;
            socket.write('250 queued\r\n');
          }
          return;
        }
        for (const line of buffer.split('\r\n')) {
          if (!line) continue;
          const cmd = line.slice(0, 4).toUpperCase();
          if (cmd === 'EHLO') socket.write('250-test\r\n250 8BITMIME\r\n');
          else if (cmd === 'DATA') {
            socket.write('354 go\r\n');
            data = true;
            buffer = buffer.slice(buffer.indexOf('DATA') + 6);
            return;
          } else if (cmd === 'QUIT') socket.end('221 bye\r\n');
          else socket.write('250 ok\r\n');
        }
        buffer = '';
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as { port: number };
    return { port, messages, close: () => new Promise((r) => server.close(() => r())) };
  }

  it('delivers a multipart mail through a plain local SMTP server (opportunistic TLS)', async () => {
    const smtp = await fakeSmtp();
    try {
      await smtpMailer(`smtp://127.0.0.1:${smtp.port}`, 'DARLING* <no-reply@darling7.store>').send(mail);
      expect(smtp.messages).toHaveLength(1);
      const raw = smtp.messages[0] as string;
      expect(raw).toContain('Subject: Sujet');
      expect(raw).toContain('multipart/alternative');
      expect(raw).toContain('no-reply@darling7.store');
    } finally {
      await smtp.close();
    }
  });

  it('refuses to talk to a non-loopback server that does not offer TLS', async () => {
    // 127.0.0.1 is loopback, so use the explicit "required" override to exercise the same code path.
    const smtp = await fakeSmtp();
    try {
      await expect(smtpMailer(`smtp://127.0.0.1:${smtp.port}?starttls=required`, 'x@example.test').send(mail)).rejects.toThrow();
      expect(smtp.messages).toHaveLength(0);
    } finally {
      await smtp.close();
    }
  });

  it('rejects when the server is unreachable', async () => {
    await expect(smtpMailer('smtp://127.0.0.1:1', 'x@example.test').send(mail)).rejects.toThrow();
  });
});
