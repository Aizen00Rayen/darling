import { Suspense } from 'react';
import type { Metadata } from 'next';
import { Badge, Notice, PageHeader } from '@/ui';
import { z } from 'zod';
import { AccessDenied } from '@/components/portal/AccessDenied';
import { DiagnosticsActions } from '@/components/portal/DiagnosticsActions';
import { PageLoading } from '@/components/portal/PageLoading';
import { apiServer } from '@/lib/api/server';
import { formatBytes, formatDuration, ipVerdictText } from '@/lib/portal/diagnostics';
import { formatDateTime } from '@/lib/portal/format';
import { requireAdmin } from '@/lib/portal/guards';
import { apiMessage } from '@/lib/portal/messages';

export const metadata: Metadata = { title: 'Diagnostic — Darling', robots: { index: false } };

const nullableString = z.string().nullable();
const schema = z.object({
  request: z.object({
    clientIp: z.string(),
    trustedProxyHops: z.number(),
    verdict: z.enum(['real', 'local_or_unknown']),
    headers: z.object({
      'x-forwarded-for': nullableString,
      'x-real-ip': nullableString,
      forwarded: nullableString,
      'cf-connecting-ip': nullableString,
    }),
  }),
  runtime: z.object({ node: z.string(), sqliteDriver: z.string(), nodeEnv: z.string(), uptimeSeconds: z.number(), startedAt: z.number() }),
  dataDir: z.object({ path: z.string(), exists: z.boolean(), writable: z.boolean(), freeBytes: z.number().nullable(), insideAppDir: z.boolean() }),
  database: z.object({ fileBytes: z.number().nullable(), migrationsApplied: z.number(), latestMigration: nullableString }),
  backups: z.object({
    count: z.number(),
    latest: z.object({ name: z.string(), bytes: z.number(), at: z.number() }).nullable(),
    keep: z.number(),
  }),
  config: z.object({
    appOrigin: z.string(),
    cookieSecure: z.boolean(),
    smtp: z.union([
      z.object({ configured: z.literal(false) }),
      z.object({ configured: z.literal(true), host: z.string(), port: z.number(), tls: z.string() }),
    ]),
    mailFromSet: z.boolean(),
    cronTokenSet: z.boolean(),
    setupTokenSet: z.boolean(),
  }),
});
type Data = z.infer<typeof schema>;

const HEADER_LABELS: [keyof Data['request']['headers'], string][] = [
  ['x-forwarded-for', 'X-Forwarded-For'],
  ['x-real-ip', 'X-Real-IP'],
  ['forwarded', 'Forwarded'],
  ['cf-connecting-ip', 'CF-Connecting-IP'],
];

const TLS_LABELS: Record<string, string> = {
  implicit: 'TLS implicite (smtps)',
  starttls: 'STARTTLS obligatoire',
  opportunistic: 'STARTTLS facultatif (local)',
};

export default function DiagnosticsPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <Content />
    </Suspense>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

const yesNo = (v: boolean) => (v ? 'Oui' : 'Non');

async function Content() {
  const me = await requireAdmin();
  if (!me.isOwner) return <AccessDenied />;

  const result = await apiServer<unknown>('/api/diagnostics');
  const parsed = result.ok ? schema.safeParse(result.data) : null;
  if (!result.ok) return <Notice tone="error">{apiMessage(result.code)}</Notice>;
  if (!parsed?.success) return <Notice tone="error">{apiMessage('generic')}</Notice>;
  const d = parsed.data;
  const verdict = ipVerdictText(d.request.verdict);
  const smtp = d.config.smtp;

  return (
    <div className="p-stack p-stack--lg">
      <PageHeader eyebrow="Administration" title="Diagnostic" />

      <section className="glass p-card" aria-labelledby="diag-ip">
        <h2 className="p-card__title" id="diag-ip">
          Adresse IP des visiteurs
        </h2>
        <Notice tone={verdict.tone === 'success' ? 'success' : 'error'}>{verdict.text}</Notice>
        <dl className="p-dl">
          <Row label="Adresse détectée pour votre requête">
            <strong>{d.request.clientIp}</strong>
          </Row>
          <Row label="TRUSTED_PROXY_HOPS">{d.request.trustedProxyHops}</Row>
          {HEADER_LABELS.map(([key, label]) => (
            <Row key={key} label={`En-tête ${label}`}>
              {d.request.headers[key] === null ? <Badge tone="neutral">absent</Badge> : <code>{d.request.headers[key]}</code>}
            </Row>
          ))}
        </dl>
        <p className="p-lead">
          Ces valeurs sont celles de votre propre requête vers cette page. Si l’adresse détectée est locale, privée ou inconnue, changez
          TRUSTED_PROXY_HOPS (essayez 1, puis 2) ou contactez le support de l’hébergeur.
        </p>
      </section>

      <section className="glass p-card" aria-labelledby="diag-runtime">
        <h2 className="p-card__title" id="diag-runtime">
          Application
        </h2>
        <dl className="p-dl">
          <Row label="Node.js">{d.runtime.node}</Row>
          <Row label="Pilote SQLite">{d.runtime.sqliteDriver}</Row>
          <Row label="NODE_ENV">{d.runtime.nodeEnv}</Row>
          <Row label="COOKIE_SECURE">{yesNo(d.config.cookieSecure)}</Row>
          <Row label="APP_ORIGIN">{d.config.appOrigin}</Row>
          <Row label="En ligne depuis">
            {formatDuration(d.runtime.uptimeSeconds)} (démarrage : {formatDateTime(new Date(d.runtime.startedAt).toISOString())})
          </Row>
        </dl>
        <p className="p-lead">
          Sur un hébergement mutualisé, l’application peut être arrêtée après un moment sans visite : la première visite suivante est alors
          plus lente et cette durée repart de zéro. C’est normal.
        </p>
      </section>

      <section className="glass p-card" aria-labelledby="diag-data">
        <h2 className="p-card__title" id="diag-data">
          Données
        </h2>
        {d.dataDir.insideAppDir ? (
          <Notice tone="error">
            Attention : le dossier de données est à l’intérieur du dossier de l’application. Un redéploiement peut l’effacer. Choisissez un
            dossier en dehors (variable DATA_DIR).
          </Notice>
        ) : null}
        {!d.dataDir.exists || !d.dataDir.writable ? <Notice tone="error">Le dossier de données est introuvable ou n’est pas accessible en écriture.</Notice> : null}
        <dl className="p-dl">
          <Row label="DATA_DIR">
            <code>{d.dataDir.path}</code>
          </Row>
          <Row label="Existe">{yesNo(d.dataDir.exists)}</Row>
          <Row label="Accessible en écriture">{yesNo(d.dataDir.writable)}</Row>
          <Row label="Espace libre">{formatBytes(d.dataDir.freeBytes)}</Row>
          <Row label="À l’intérieur de l’application">{yesNo(d.dataDir.insideAppDir)}</Row>
          <Row label="Taille de la base">{formatBytes(d.database.fileBytes)}</Row>
          <Row label="Migrations appliquées">
            {d.database.migrationsApplied}
            {d.database.latestMigration ? ` (dernière : ${d.database.latestMigration})` : ''}
          </Row>
        </dl>
      </section>

      <section className="glass p-card" aria-labelledby="diag-backups">
        <h2 className="p-card__title" id="diag-backups">
          Sauvegardes
        </h2>
        <dl className="p-dl">
          <Row label="Dernière sauvegarde">
            {d.backups.latest ? `${formatDateTime(new Date(d.backups.latest.at).toISOString())} — ${formatBytes(d.backups.latest.bytes)}` : 'Aucune'}
          </Row>
          <Row label="Sauvegardes conservées">
            {d.backups.count} (maximum {d.backups.keep})
          </Row>
          <Row label="Sauvegarde automatique (CRON_TOKEN)">{d.config.cronTokenSet ? 'Activée' : 'Désactivée : CRON_TOKEN n’est pas défini'}</Row>
        </dl>
        {!d.backups.latest ? <Notice tone="info">Aucune sauvegarde pour le moment. Cliquez sur « Sauvegarder maintenant » avant de mettre le site en ligne.</Notice> : null}
        <p className="p-lead">
          Une sauvegarde contient toutes les données personnelles (clients, téléphones, adresses, comptes). Le téléchargement demande une
          confirmation ; gardez le fichier en lieu sûr.
        </p>
        <DiagnosticsActions hasBackup={d.backups.latest !== null} smtpConfigured={smtp.configured} />
      </section>

      <section className="glass p-card" aria-labelledby="diag-mail">
        <h2 className="p-card__title" id="diag-mail">
          E-mails
        </h2>
        <dl className="p-dl">
          <Row label="Serveur SMTP">{smtp.configured ? `${smtp.host}:${smtp.port}` : 'Non configuré (SMTP_URL absent)'}</Row>
          {smtp.configured ? <Row label="Sécurité">{TLS_LABELS[smtp.tls] ?? smtp.tls}</Row> : null}
          <Row label="MAIL_FROM">{d.config.mailFromSet ? 'Défini' : 'Non défini (valeur par défaut)'}</Row>
        </dl>
        {!smtp.configured ? <Notice tone="info">Sans serveur d’e-mail, les invitations et les réinitialisations de mot de passe ne peuvent pas être envoyées.</Notice> : null}
        <p className="p-lead">Le test envoie un message à votre propre adresse (3 par heure). Les identifiants du serveur ne sont jamais affichés.</p>
      </section>

      <section className="glass p-card" aria-labelledby="diag-setup">
        <h2 className="p-card__title" id="diag-setup">
          Sécurité
        </h2>
        <dl className="p-dl">
          <Row label="SETUP_TOKEN">{d.config.setupTokenSet ? 'Encore défini : retirez-le maintenant que le propriétaire existe' : 'Absent (bien)'}</Row>
        </dl>
      </section>
    </div>
  );
}
