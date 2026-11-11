import { describe, expect, it } from 'vitest';
import { inviteMail, resetMail } from './templates';

const link = 'http://localhost:3000/invitation?token=abc_DEF-123';

describe('inviteMail', () => {
  it('is in French and carries the link in text and html', () => {
    const m = inviteMail({ fullName: 'Ines Amrani', link, roleLabel: 'Influenceuse' });
    expect(m.subject).toMatch(/DARLING\*/);
    expect(m.text).toContain('Bonjour Ines Amrani');
    expect(m.text).toContain(link);
    expect(m.text).toContain('Influenceuse');
    expect(m.html).toContain(`href="${link}"`);
    expect(m.html).toContain('lang="fr"');
    expect(m.html).toContain('Choisir mon mot de passe');
  });

  it('escapes every interpolated value in the html and never mangles the subject', () => {
    const m = inviteMail({ fullName: '<script>alert(1)</script> "O\'Neil" & co', link: 'http://x.test/?a=1&b="2"', roleLabel: '<b>role</b>' });
    expect(m.html).not.toContain('<script>');
    expect(m.html).not.toContain('<b>role</b>');
    expect(m.html).toContain('&lt;script&gt;');
    expect(m.html).toContain('&amp; co');
    expect(m.html).toContain('a=1&amp;b=&quot;2&quot;');
    expect(m.subject).not.toContain('&');
  });
});

describe('resetMail', () => {
  it('is in French, mentions the 30 minute validity and carries the link in text and html', () => {
    const m = resetMail({ fullName: 'Ines', link: 'http://localhost:3000/reinitialiser?token=abc' });
    expect(m.subject).toMatch(/mot de passe/);
    expect(m.text).toContain('30 minutes');
    expect(m.text).toContain('http://localhost:3000/reinitialiser?token=abc');
    expect(m.html).toContain('href="http://localhost:3000/reinitialiser?token=abc"');
    expect(m.html).toContain('30 minutes');
  });

  it('escapes a hostile name', () => {
    const m = resetMail({ fullName: '"><img src=x onerror=alert(1)>', link: 'http://localhost:3000/r' });
    expect(m.html).not.toContain('<img');
  });
});
