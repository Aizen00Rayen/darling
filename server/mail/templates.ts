import type { Mail } from './mailer';

const PINK = '#ed007d';
const PAPER = '#fff6fa';
const INK = '#24141c';

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escapes a value for HTML text and quoted attributes. Every interpolated value goes through this. */
function esc(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] as string);
}

interface Layout {
  title: string;
  fullName: string;
  paragraphs: string[];
  buttonLabel: string;
  link: string;
  footer: string;
}

function layout(l: Layout): string {
  const link = esc(l.link);
  const paragraphs = l.paragraphs
    .map((p) => `<p style="margin:0 0 16px 0;font-size:16px;line-height:24px;color:${INK};">${p}</p>`)
    .join('');
  return `<!doctype html>
<html lang="fr">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(l.title)}</title></head>
<body style="margin:0;padding:0;background:${PAPER};font-family:'DM Sans',Arial,Helvetica,sans-serif;color:${INK};">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${PAPER};">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="560" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:16px;">
<tr><td style="padding:24px 32px;border-bottom:4px solid ${PINK};font-family:'Space Grotesk',Arial,Helvetica,sans-serif;font-size:24px;font-weight:700;letter-spacing:2px;color:${PINK};">DARLING*</td></tr>
<tr><td style="padding:32px;">
<p style="margin:0 0 16px 0;font-size:16px;line-height:24px;color:${INK};">Bonjour ${esc(l.fullName)},</p>
${paragraphs}
<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:24px 0;"><tr><td align="center" bgcolor="${PINK}" style="border-radius:999px;"><a href="${link}" style="display:inline-block;padding:14px 28px;font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:999px;">${esc(l.buttonLabel)}</a></td></tr></table>
<p style="margin:0 0 8px 0;font-size:14px;line-height:20px;color:${INK};">Si le bouton ne fonctionne pas, copiez ce lien dans votre navigateur :</p>
<p style="margin:0 0 16px 0;font-size:14px;line-height:20px;word-break:break-all;"><a href="${link}" style="color:${PINK};">${link}</a></p>
<p style="margin:0;font-size:13px;line-height:20px;color:#6b5560;">${l.footer}</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

export function inviteMail(p: { fullName: string; link: string; roleLabel: string }): Omit<Mail, 'to'> {
  const subject = 'Bienvenue chez DARLING* : activez votre accès';
  const text = [
    `Bonjour ${p.fullName},`,
    '',
    `Vous avez été invité(e) à rejoindre DARLING* en tant que ${p.roleLabel}.`,
    'Pour activer votre accès, choisissez votre mot de passe grâce à ce lien :',
    '',
    p.link,
    '',
    'Ce lien est à usage unique. Si vous n’attendiez pas cette invitation, ignorez simplement ce message.',
    '',
    'DARLING*',
  ].join('\n');
  const html = layout({
    title: subject,
    fullName: p.fullName,
    paragraphs: [
      `Vous avez été invité(e) à rejoindre DARLING* en tant que <strong>${esc(p.roleLabel)}</strong>.`,
      'Pour activer votre accès, choisissez votre mot de passe.',
    ],
    buttonLabel: 'Choisir mon mot de passe',
    link: p.link,
    footer: 'Ce lien est à usage unique. Si vous n’attendiez pas cette invitation, ignorez simplement ce message.',
  });
  return { subject, text, html };
}

export function resetMail(p: { fullName: string; link: string }): Omit<Mail, 'to'> {
  const subject = 'DARLING* : réinitialisation de votre mot de passe';
  const text = [
    `Bonjour ${p.fullName},`,
    '',
    'Vous avez demandé la réinitialisation de votre mot de passe DARLING*.',
    'Choisissez un nouveau mot de passe grâce à ce lien, valable 30 minutes et à usage unique :',
    '',
    p.link,
    '',
    'Si vous n’êtes pas à l’origine de cette demande, ignorez ce message : votre mot de passe actuel reste inchangé.',
    '',
    'DARLING*',
  ].join('\n');
  const html = layout({
    title: subject,
    fullName: p.fullName,
    paragraphs: [
      'Vous avez demandé la réinitialisation de votre mot de passe DARLING*.',
      'Ce lien est valable <strong>30 minutes</strong> et à usage unique.',
    ],
    buttonLabel: 'Choisir un nouveau mot de passe',
    link: p.link,
    footer: 'Si vous n’êtes pas à l’origine de cette demande, ignorez ce message : votre mot de passe actuel reste inchangé.',
  });
  return { subject, text, html };
}

/** The diagnostics test mail: proves the SMTP settings work. Contains no secret and no one-time link. */
export function testMail(p: { fullName: string; origin: string }): Omit<Mail, 'to'> {
  const subject = 'DARLING* : e-mail de test';
  const text = [
    `Bonjour ${p.fullName},`,
    '',
    'Ceci est un e-mail de test envoyé depuis la page Diagnostic. Si vous le lisez, l’envoi d’e-mails fonctionne.',
    '',
    p.origin,
    '',
    'DARLING*',
  ].join('\n');
  const html = layout({
    title: subject,
    fullName: p.fullName,
    paragraphs: ['Ceci est un e-mail de test envoyé depuis la page Diagnostic. Si vous le lisez, l’envoi d’e-mails fonctionne.'],
    buttonLabel: 'Ouvrir DARLING*',
    link: p.origin,
    footer: 'Aucune action n’est nécessaire.',
  });
  return { subject, text, html };
}
