import { afterEach, describe, expect, it, vi } from 'vitest';

const runStartupChecks = vi.fn();
const installShutdownDrain = vi.fn();
vi.mock('./server/startup', () => ({ runStartupChecks: (...a: unknown[]) => runStartupChecks(...a), installShutdownDrain: (...a: unknown[]) => installShutdownDrain(...a) }));

import { register } from './instrumentation';

afterEach(() => {
  vi.unstubAllEnvs();
  runStartupChecks.mockReset();
  installShutdownDrain.mockReset();
});

describe('instrumentation register()', () => {
  it('does nothing outside the nodejs runtime', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'edge');
    await register();
    expect(runStartupChecks).not.toHaveBeenCalled();
    vi.stubEnv('NEXT_RUNTIME', '');
    await register();
    expect(runStartupChecks).not.toHaveBeenCalled();
  });

  it('on the nodejs runtime checks the configuration and database, then installs the shutdown drain', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    await register();
    expect(runStartupChecks).toHaveBeenCalledTimes(1);
    expect(installShutdownDrain).toHaveBeenCalledTimes(1);
  });

  it('lets a startup failure propagate so the server stops', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    runStartupChecks.mockImplementation(() => {
      throw new Error('Invalid configuration: APP_ORIGIN');
    });
    await expect(register()).rejects.toThrow('Invalid configuration');
    expect(installShutdownDrain).not.toHaveBeenCalled();
  });
});
