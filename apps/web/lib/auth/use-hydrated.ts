import { useSyncExternalStore } from 'react';

const subscribe = () => () => {};

/** false while rendering on the server and during hydration, true once the component runs in the browser. */
export function useHydrated(): boolean {
  return useSyncExternalStore(subscribe, () => true, () => false);
}
