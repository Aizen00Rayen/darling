import { Suspense } from 'react';
import { PageLoading } from '@/components/portal/PageLoading';
import type { Metadata } from 'next';
import { Notice, PageHeader } from '@/ui';
import { SETTING_DEFAULTS, SETTINGS } from '@/shared';
import { z } from 'zod';
import { AccessDenied } from '@/components/portal/AccessDenied';
import { SettingsForm } from '@/components/portal/SettingsForm';
import { apiServer } from '@/lib/api/server';
import { requireAdmin } from '@/lib/portal/guards';
import { apiMessage } from '@/lib/portal/messages';

export const metadata: Metadata = { title: 'Paramètres — Darling', robots: { index: false } };

export default function SettingsPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <Content />
    </Suspense>
  );
}

async function Content() {
  const me = await requireAdmin();
  if (!me.permissions.includes('settings.manage')) return <AccessDenied />;

  const result = await apiServer<unknown>('/api/settings');
  const parsed = result.ok ? z.object(SETTINGS).safeParse(result.data) : null;
  return (
    <div className="p-stack">
      <PageHeader eyebrow="Administration" title="Paramètres" />
      {!result.ok ? (
        <Notice tone="error">{apiMessage(result.code)}</Notice>
      ) : !parsed?.success ? (
        <Notice tone="error">{apiMessage('generic')}</Notice>
      ) : (
        <SettingsForm
          initial={{ ...SETTING_DEFAULTS, ...parsed.data }}
        />
      )}
    </div>
  );
}
