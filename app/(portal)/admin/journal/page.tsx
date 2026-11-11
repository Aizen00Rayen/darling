import { Suspense } from 'react';
import { PageLoading } from '@/components/portal/PageLoading';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge, Notice, PageHeader, Table } from '@/ui';
import { z } from 'zod';
import { AccessDenied } from '@/components/portal/AccessDenied';
import { Pager } from '@/components/portal/Pager';
import { apiServer } from '@/lib/api/server';
import type { ApiResult } from '@/lib/api/client';
import { formatDateTime } from '@/lib/portal/format';
import { requireAdmin } from '@/lib/portal/guards';
import { auditActionLabel, loginReasonLabel } from '@/lib/portal/labels';
import { apiMessage } from '@/lib/portal/messages';
import { buildHref, firstParam, parsePage } from '@/lib/portal/query';

export const metadata: Metadata = { title: 'Journal — Darling', robots: { index: false } };

const PAGE_SIZE = 50;
const BASE = '/admin/journal';
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const auditSchema = z.object({
  items: z.array(
    z.object({
      id: z.number(),
      at: z.string(),
      actor: z.object({ id: z.string(), fullName: z.string() }).nullable(),
      action: z.string(),
      entityType: z.string(),
      entityId: z.string(),
      before: z.unknown().optional(),
      after: z.unknown().optional(),
      reason: z.string().nullable(),
    }),
  ),
  total: z.number(),
});
const loginSchema = z.object({
  items: z.array(
    z.object({
      id: z.number(),
      at: z.string(),
      email: z.string(),
      success: z.boolean(),
      reason: z.string().nullable(),
      ip: z.string().nullable(),
    }),
  ),
  total: z.number(),
});

/** First validation message of a failed API call (the date filters are checked by the API), else the code's message. */
function errorText(result: Extract<ApiResult<unknown>, { ok: false }>): string {
  const first = result.errors ? Object.values(result.errors)[0] : undefined;
  return first ?? apiMessage(result.code);
}

const isPresent = (v: unknown) => v !== null && v !== undefined;

function Json({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined) return null;
  // React escapes the text: nothing from the log is ever rendered as HTML.
  return (
    <>
      <p className="dl-eyebrow">{label}</p>
      <pre className="p-json">{JSON.stringify(value, null, 2)}</pre>
    </>
  );
}

export default function JournalPage(props: PageProps<'/admin/journal'>) {
  return (
    <Suspense fallback={<PageLoading />}>
      <Content {...props} />
    </Suspense>
  );
}

async function Content({ searchParams }: PageProps<'/admin/journal'>) {
  const [me, sp] = await Promise.all([requireAdmin(), searchParams]);
  if (!me.permissions.includes('audit.read')) return <AccessDenied />;

  const tab = firstParam(sp.tab) === 'connexions' ? 'connexions' : 'audit';
  const dayOf = (v: string | string[] | undefined) => {
    const d = firstParam(v);
    return d && DAY.test(d) ? d : undefined;
  };
  const from = dayOf(sp.from);
  const to = dayOf(sp.to);
  const page = parsePage(sp.page);
  const entityType = tab === 'audit' ? firstParam(sp.entityType)?.slice(0, 100) : undefined;
  const email = tab === 'connexions' ? firstParam(sp.email)?.slice(0, 254) : undefined;
  const successParam = tab === 'connexions' ? firstParam(sp.success) : undefined;
  const success = successParam === 'true' || successParam === 'false' ? successParam : undefined;

  const filters = { tab, from, to, entityType, email, success };

  return (
    <div className="p-stack">
      <PageHeader eyebrow="Administration" title="Journal" />

      <nav className="p-tabs" aria-label="Sections du journal">
        <Link className="p-tab" href={buildHref(BASE, { tab: 'audit' })} aria-current={tab === 'audit' ? 'page' : undefined}>
          Journal d’audit
        </Link>
        <Link className="p-tab" href={buildHref(BASE, { tab: 'connexions' })} aria-current={tab === 'connexions' ? 'page' : undefined}>
          Connexions
        </Link>
      </nav>

      <form className="p-filters glass" method="get" action={BASE} role="search" aria-label="Filtrer le journal">
        <input type="hidden" name="tab" value={tab} />
        {tab === 'audit' ? (
          <div className="dl-field">
            <label className="dl-field__label" htmlFor="j-entity">
              Type d’entité
            </label>
            <input id="j-entity" name="entityType" list="j-entities" defaultValue={entityType ?? ''} maxLength={100} placeholder="user, setting…" />
            <datalist id="j-entities">
              <option value="user" />
              <option value="setting" />
              <option value="order" />
              <option value="commission" />
              <option value="payout" />
            </datalist>
          </div>
        ) : (
          <>
            <div className="dl-field">
              <label className="dl-field__label" htmlFor="j-email">
                E-mail
              </label>
              <input id="j-email" type="search" name="email" defaultValue={email ?? ''} maxLength={254} />
            </div>
            <div className="dl-field">
              <label className="dl-field__label" htmlFor="j-success">
                Résultat
              </label>
              <select id="j-success" name="success" defaultValue={success ?? ''}>
                <option value="">Tous</option>
                <option value="true">Réussies</option>
                <option value="false">Échecs</option>
              </select>
            </div>
          </>
        )}
        <div className="dl-field">
          <label className="dl-field__label" htmlFor="j-from">
            Du
          </label>
          <input id="j-from" type="date" name="from" defaultValue={from ?? ''} />
        </div>
        <div className="dl-field">
          <label className="dl-field__label" htmlFor="j-to">
            Au
          </label>
          <input id="j-to" type="date" name="to" defaultValue={to ?? ''} />
        </div>
        <div className="p-filters__actions">
          <button type="submit" className="dl-btn dl-btn--primary">
            Filtrer
          </button>
          <Link className="dl-btn dl-btn--ghost" href={buildHref(BASE, { tab })}>
            Réinitialiser
          </Link>
        </div>
      </form>

      {tab === 'audit' ? (
        <AuditTable params={{ entityType, from, to, page }} page={page} hrefFor={(p) => buildHref(BASE, { ...filters, page: p })} />
      ) : (
        <LoginTable
          params={{ email, success, from, to, page }}
          page={page}
          hrefFor={(p) => buildHref(BASE, { ...filters, page: p })}
        />
      )}
    </div>
  );
}

type TableProps<P> = { params: P; page: number; hrefFor: (page: number) => string };

async function AuditTable({ params, page, hrefFor }: TableProps<Record<string, string | number | undefined>>) {
  const result = await apiServer<unknown>(buildHref('/api/audit-log', params));
  if (!result.ok) return <Notice tone="error">{errorText(result)}</Notice>;
  const parsed = auditSchema.safeParse(result.data);
  if (!parsed.success) return <Notice tone="error">{apiMessage('generic')}</Notice>;
  type Row = (typeof parsed.data.items)[number];
  return (
    <>
      <Table<Row>
        rows={parsed.data.items}
        empty="Aucune entrée dans le journal pour ces critères."
        columns={[
          { key: 'at', header: 'Date', render: (r) => formatDateTime(r.at) },
          { key: 'actor', header: 'Acteur', render: (r) => r.actor?.fullName ?? 'Système' },
          { key: 'action', header: 'Action', render: (r) => auditActionLabel(r.action) },
          { key: 'entity', header: 'Entité', hideBelow: 'sm', render: (r) => `${r.entityType} · ${r.entityId}` },
          { key: 'reason', header: 'Motif', hideBelow: 'sm', render: (r) => r.reason ?? '—' },
          {
            key: 'details',
            header: 'Détails',
            render: (r) => (isPresent(r.before) || isPresent(r.after) ? <Details row={r} /> : '—'),
          },
        ]}
      />
      <Pager page={page} total={parsed.data.total} pageSize={PAGE_SIZE} hrefFor={hrefFor} />
    </>
  );
}

function Details({ row }: { row: { before?: unknown; after?: unknown; entityType: string; entityId: string; reason: string | null } }) {
  return (
    <details className="p-details-cell">
      <summary>Voir</summary>
      <p className="p-lead">
        Entité : {row.entityType} · {row.entityId}
        {row.reason ? ` — Motif : ${row.reason}` : ''}
      </p>
      <Json label="Avant" value={row.before} />
      <Json label="Après" value={row.after} />
    </details>
  );
}

async function LoginTable({ params, page, hrefFor }: TableProps<Record<string, string | number | undefined>>) {
  const result = await apiServer<unknown>(buildHref('/api/login-events', params));
  if (!result.ok) return <Notice tone="error">{errorText(result)}</Notice>;
  const parsed = loginSchema.safeParse(result.data);
  if (!parsed.success) return <Notice tone="error">{apiMessage('generic')}</Notice>;
  type Row = (typeof parsed.data.items)[number];
  return (
    <>
      <Table<Row>
        rows={parsed.data.items}
        empty="Aucune connexion pour ces critères."
        columns={[
          { key: 'at', header: 'Date', render: (r) => formatDateTime(r.at) },
          { key: 'email', header: 'E-mail', render: (r) => r.email },
          {
            key: 'result',
            header: 'Résultat',
            render: (r) => <Badge tone={r.success ? 'success' : 'danger'}>{r.success ? 'Réussie' : 'Échec'}</Badge>,
          },
          { key: 'reason', header: 'Raison', hideBelow: 'sm', render: (r) => loginReasonLabel(r.reason) },
          { key: 'ip', header: 'IP', hideBelow: 'md', render: (r) => r.ip ?? '—' },
        ]}
      />
      <Pager page={page} total={parsed.data.total} pageSize={PAGE_SIZE} hrefFor={hrefFor} />
    </>
  );
}
