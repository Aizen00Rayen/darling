import { Notice, PageHeader } from '@/ui';

/** Rendered (HTTP 200, no redirect) when a signed-in user lacks the permission a page needs. */
export function AccessDenied() {
  return (
    <div className="p-stack">
      <PageHeader title="Accès refusé" />
      <Notice tone="error">Vous n’avez pas la permission d’accéder à cette page.</Notice>
    </div>
  );
}
