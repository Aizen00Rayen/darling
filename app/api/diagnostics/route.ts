import { collectDiagnostics } from '@/server/diagnostics/diagnostics';
import { json, withAccess } from '@/server/security/access';

export const access = { kind: 'owner' } as const;

/** Owner diagnostics: the address the app derives for THIS request and the proxy headers behind it, plus runtime and storage health. No secrets. */
export const GET = withAccess(access, ({ request, ctx, ip }) => json(200, collectDiagnostics(ctx, request.headers, ip)));
