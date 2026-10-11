import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createFleetApi, type FleetApi } from './api/client';
import type { DeviceMessageEvent } from './api/types';
import { type LiveStatus, LiveUpdates } from './hooks/liveUpdates';
import type { ShellContext } from './shell-contract';

interface FleetContextValue {
  shell: ShellContext;
  api: FleetApi;
  live: LiveUpdates;
}

const FleetCtx = createContext<FleetContextValue | undefined>(undefined);

export function FleetProvider({
  shell,
  children,
  api: apiOverride,
  live: liveOverride,
}: {
  shell: ShellContext;
  children: ReactNode;
  api?: FleetApi;
  live?: LiveUpdates;
}) {
  // The shell may hand us a new props object on every render; keep the API client and WebSocket stable and
  // always reach the latest token getter through a ref.
  const shellRef = useRef(shell);
  shellRef.current = shell;
  const env = shell.env;
  const services = useMemo(() => {
    const getAccessToken = () => shellRef.current.getAccessToken();
    return {
      api: apiOverride ?? createFleetApi({ env, getAccessToken }),
      live: liveOverride ?? new LiveUpdates(env, getAccessToken),
    };
  }, [env, apiOverride, liveOverride]);
  const value = useMemo(() => ({ shell, ...services }), [shell, services]);

  useEffect(() => {
    value.live.start();
    return () => value.live.stop();
  }, [value.live]);

  return <FleetCtx.Provider value={value}>{children}</FleetCtx.Provider>;
}

export function useFleet() {
  const ctx = useContext(FleetCtx);
  if (!ctx) throw new Error('useFleet must be used inside FleetProvider');
  return ctx;
}

/** Calls the listener for every live device message (optionally for one device). */
export function useDeviceMessages(listener: (event: DeviceMessageEvent) => void, deviceId?: string) {
  const { live } = useFleet();
  useEffect(
    () =>
      live.subscribe((event) => {
        if (!deviceId || event.deviceId === deviceId) listener(event);
      }),
    [live, listener, deviceId],
  );
}

export function useLiveStatus(): LiveStatus {
  const { live } = useFleet();
  const [status, setStatus] = useState(live.status);
  useEffect(() => {
    setStatus(live.status);
    return live.onStatus(setStatus);
  }, [live]);
  return status;
}
