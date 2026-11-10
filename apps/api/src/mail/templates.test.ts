import { describe, expect, it } from 'vitest';
import { inviteMail, resetMail } from './templates';

const LINK = 'https://darling7.store/set-password?token=abc_DEF-123&next=%2Fadmin';
const EVIL = '<script>alert("x")</script> & "O\'Brien"';

describe('inviteMail', () => {
  it('is in French and carries the link in text and html', () => {
    const mail = inviteMail({ fullName: 'Inès Benali', link: LINK, roleLabel: 'Influenceuse' });
    expect(mail.subject).toMatch(/DARLING\*/);
    expect(mail.text).toContain('Bonjour Inès Benali');
    expect(mail.text).toContain('Influenceuse');
    expect(mail.text).toContain(LINK);
    expect(mail.html).toContain('Influenceuse');
    expect(mail.html).toContain('#ed007d');
    expect(mail.html).toContain('<table');
    // The link appears as a button and as plain text, HTML-escaped (& becomes &amp;).
    const escapedLink = LINK.replaceAll('&', '&amp;');
    expect(mail.html.split(`href="${escapedLink}"`).length - 1).toBeGreaterThanOrEqual(1);
    expect(mail.html.split(escapedLink).length - 1).toBeGreaterThanOrEqual(2);
    expect(mail).not.toHaveProperty('to');
  });

  it('escapes every interpolated value in the html and never in the subject', () => {
    const mail = inviteMail({ fullName: EVIL, link: `https://x.test/?a="><script>1</script>`, roleLabel: EVIL });
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).not.toContain('"><script');
    expect(mail.html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &quot;O&#39;Brien&quot;');
    expect(mail.subject).not.toContain('script');
    expect(mail.subject).not.toMatch(/[\r\n]/);
    // Plain text stays literal.
    expect(mail.text).toContain(EVIL);
  });
});

describe('resetMail', () => {
  it('is in French, mentions the 30 minute validity and carries the link in text and html', () => {
    const mail = resetMail({ fullName: 'Inès Benali', link: LINK });
    expect(mail.subject).toMatch(/mot de passe/i);
    expect(mail.text).toContain('Bonjour Inès Benali');
    expect(mail.text).toContain('30 minutes');
    expect(mail.text).toContain(LINK);
    expect(mail.html).toContain('30 minutes');
    expect(mail.html).toContain('#ed007d');
    const escapedLink = LINK.replaceAll('&', '&amp;');
    expect(mail.html).toContain(`href="${escapedLink}"`);
    expect(mail.html.split(escapedLink).length - 1).toBeGreaterThanOrEqual(2);
  });

  it('escapes a hostile name', () => {
    const mail = resetMail({ fullName: EVIL, link: LINK });
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;');
    expect(mail.subject).not.toMatch(/[\r\n<]/);
    expect(mail.text).toContain(EVIL);
  });
});
