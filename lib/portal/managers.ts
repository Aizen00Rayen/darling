import { z } from 'zod';
import { apiServer } from '@/lib/api/server';

export interface ManagerOption {
  id: string;
  fullName: string;
}

const listSchema = z.object({ items: z.array(z.object({ id: z.string(), fullName: z.string() })) });

/** Active sous-managers, for the "Sous-manager" select (server side; needs users.manage, which the user pages require anyway). */
export async function loadManagers(): Promise<ManagerOption[]> {
  const result = await apiServer<unknown>('/api/users?role=sub_manager&status=active');
  const parsed = result.ok ? listSchema.safeParse(result.data) : null;
  return parsed?.success ? parsed.data.items.map(({ id, fullName }) => ({ id, fullName })) : [];
}
