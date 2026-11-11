import { connection } from 'next/server';
import { redirect } from 'next/navigation';
import { setupAvailable } from '@/server/admin/first-owner';
import { getServerContext } from '@/server/context';
import { logError } from '@/server/log';
import { SetupForm } from './SetupForm';

/**
 * The /configuration page body: the setup form while the one-time setup is open (no user yet AND SETUP_TOKEN set),
 * otherwise a redirect to the login (the page does not exist for visitors afterwards, and nothing says why).
 */
export async function SetupGate() {
  await connection(); // request-time: the answer depends on the database
  let available = false;
  try {
    available = setupAvailable(getServerContext());
  } catch (err) {
    logError('setup.availability_failed', err);
  }
  if (!available) redirect('/connexion');
  return <SetupForm />;
}
