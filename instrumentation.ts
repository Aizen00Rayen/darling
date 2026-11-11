// Runs once when the server starts. On the Node.js runtime only: validate the configuration and the database
// before serving anything, and arrange for pending background mail to be drained on shutdown.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { runStartupChecks, installShutdownDrain } = await import('./server/startup');
  runStartupChecks();
  installShutdownDrain();
}
