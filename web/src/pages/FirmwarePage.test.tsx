import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderFleet } from '../test/render';
import { FirmwarePage } from './FirmwarePage';

const v = (version: string, extra = {}) => ({
  version,
  timestamp: '2026-10-11T12:00:00Z',
  firmware_path: 'p',
  size: 1024,
  sha256: 'cd'.repeat(32),
  ...extra,
});

test('lists projects and a project’s builds, and promotes sandbox builds', async () => {
  const promote = vi.fn(async () => ({}));
  renderFleet(<FirmwarePage />, {
    path: '/firmware/BootBoots',
    route: '/firmware/:project',
    api: {
      listProjects: async () => ({
        env: 'prod',
        projects: [{ name: 'BootBoots', latest: '1.0.331', versions: 2, artefactType: 'bin' as const }],
      }),
      listFirmware: async () => ({
        env: 'prod',
        project: 'BootBoots',
        versions: [v('1.0.330', { signed: true })],
        promotable: [v('1.0.331')],
      }),
      promote,
    },
  });

  expect(await screen.findByText('latest 1.0.331')).toBeInTheDocument();
  expect(await screen.findByText('1.0.330')).toBeInTheDocument();
  expect(screen.getByText('signed')).toBeInTheDocument();
  expect(screen.getByText('In sandbox, not yet in prod')).toBeInTheDocument();

  await userEvent.click(screen.getByRole('button', { name: 'Promote' }));
  expect(promote).toHaveBeenCalledWith('BootBoots', '1.0.331');
  expect(await screen.findByText(/Promoted 1.0.331/)).toBeInTheDocument();
});

test('asks for a project when none is chosen', async () => {
  renderFleet(<FirmwarePage />, {
    path: '/firmware',
    route: '/firmware',
    api: { listProjects: async () => ({ env: 'sandbox', projects: [] }) },
  });
  expect(await screen.findByText('Choose a project to see its builds.')).toBeInTheDocument();
});
