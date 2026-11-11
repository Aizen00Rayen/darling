import { Suspense } from 'react';
import { PageLoading } from '@/components/portal/PageLoading';
import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHeader } from '@/ui';
import { AccessDenied } from '@/components/portal/AccessDenied';
import { OrderManualForm } from '@/components/portal/OrderManualForm';
import { requireAdmin } from '@/lib/portal/guards';

export const metadata: Metadata = { title: 'Nouvelle commande — Darling', robots: { index: false } };

export default function NewOrderPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <Content />
    </Suspense>
  );
}

async function Content() {
  const me = await requireAdmin();
  if (!me.permissions.includes('orders.write')) return <AccessDenied />;
  return (
    <div className="p-stack">
      <Link className="p-back" href="/admin/commandes">
        ← Commandes
      </Link>
      <PageHeader eyebrow="Commandes" title="Nouvelle commande" />
      <section className="p-card glass" aria-label="Nouvelle commande">
        <p className="p-lead">Commande reçue par Instagram, WhatsApp ou un autre canal. Les prix sont calculés automatiquement.</p>
        <OrderManualForm />
      </section>
    </div>
  );
}
