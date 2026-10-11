import { ThemeProvider } from '@mui/material/styles';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { FleetApi } from '../api/client';
import type { DeviceMessageEvent } from '../api/types';
import { FleetProvider } from '../FleetContext';
import type { LiveUpdates } from '../hooks/liveUpdates';
import type { ShellContext } from '../shell-contract';
import { theme } from '../theme';

export const shell = {
  contractVersion: 1,
  env: 'sandbox',
  basePath: '/fleet',
  region: 'eu-west-2',
  userPoolId: 'pool',
  user: { sub: 's', username: 'martin' },
  getAccessToken: async () => 'token',
  getIdToken: async () => 'id',
  getAwsCredentials: async () => {
    throw new Error('no');
  },
  signOut: () => {},
} as ShellContext;

export function fakeLive() {
  const listeners = new Set<(e: DeviceMessageEvent) => void>();
  const live = {
    status: 'live',
    start: () => {},
    stop: () => {},
    subscribe: (l: (e: DeviceMessageEvent) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    onStatus: () => () => {},
  } as unknown as LiveUpdates;
  return {
    live,
    emit: (e: DeviceMessageEvent) => {
      for (const l of listeners) l(e);
    },
  };
}

export function renderFleet(
  ui: ReactElement,
  opts: { api: Partial<FleetApi>; live?: LiveUpdates; path?: string; route?: string },
) {
  const live = opts.live ?? fakeLive().live;
  return render(
    <ThemeProvider theme={theme}>
      <FleetProvider shell={shell} api={opts.api as FleetApi} live={live}>
        <MemoryRouter initialEntries={[opts.path ?? '/']}>
          <Routes>
            <Route path={opts.route ?? '*'} element={ui} />
          </Routes>
        </MemoryRouter>
      </FleetProvider>
    </ThemeProvider>,
  );
}
