import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Device, FirmwareListing } from '../api/types';
import { renderFleet } from '../test/render';
import { OtaPanel } from './OtaPanel';

const listing: FirmwareListing = {
  env: 'sandbox',
  project: 'BootBoots',
  versions: [
    {
      version: '1.0.331',
      timestamp: '2026-10-11T12:00:00Z',
      firmware_path: 'p',
      size: 2048,
      sha256: 'ab'.repeat(32),
    },
    { version: '1.0.330', timestamp: '2026-10-10T12:00:00Z', firmware_path: 'p', size: 2048 },
  ],
  promotable: [],
};

const device = (extra: Partial<Device> = {}): Device => ({
  deviceId: 'BootBootsThing',
  project: 'bootboots',
  capabilities: [],
  hasThing: true,
  registered: true,
  currentVersion: '1.0.330',
  ...extra,
});

test('starts an update to the newest version and reports it', async () => {
  const startOta = vi.fn(async () => ({
    deviceId: 'BootBootsThing',
    otaState: { phase: 'requested' as const, targetVersion: '1.0.331', updatedAt: new Date().toISOString() },
    signed: false,
    awaitsApproval: false,
  }));
  const onDeviceChange = vi.fn();
  renderFleet(<OtaPanel device={device()} onDeviceChange={onDeviceChange} />, {
    api: { listFirmware: async () => listing, startOta, sendCommand: vi.fn(async () => ({})) },
  });

  await userEvent.click(await screen.findByRole('button', { name: 'Update to 1.0.331' }));

  expect(startOta).toHaveBeenCalledWith('BootBootsThing', '1.0.331');
  expect(onDeviceChange).toHaveBeenCalledWith(
    expect.objectContaining({ otaState: expect.objectContaining({ phase: 'requested' }) }),
  );
  expect(screen.getByText(/sha256 abab/)).toBeInTheDocument();
});

test('shows approval waits as normal, not as a hang', async () => {
  renderFleet(
    <OtaPanel
      device={device({
        capabilities: ['ota', 'ota-signed', 'ota-approval'],
        otaState: {
          phase: 'awaiting_approval',
          targetVersion: '1.0.331',
          updatedAt: new Date().toISOString(),
        },
      })}
      onDeviceChange={() => {}}
    />,
    { api: { listFirmware: async () => listing, cancelOta: vi.fn(async () => ({})) } },
  );

  expect(await screen.findByText(/waiting for you to approve it on the device/)).toBeInTheDocument();
  expect(screen.getByText(/accepts signed builds only/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Cancel update' })).toBeInTheDocument();
  expect(screen.queryByText(/No word from the device/)).not.toBeInTheDocument();
});

test.each([
  ['rolled_back', 'rolled back', /failed its self-test and rolled back/],
  ['error', 'rejected', /rejected on the device/],
  ['error', 'approval timed out', /approval timed out/],
] as const)('explains %s / %s', async (phase, message, text) => {
  renderFleet(
    <OtaPanel
      device={device({ otaState: { phase, message, updatedAt: new Date().toISOString() } })}
      onDeviceChange={() => {}}
    />,
    { api: { listFirmware: async () => listing } },
  );
  expect(await screen.findByText(text)).toBeInTheDocument();
});

test('warns when a non-approval update has gone quiet', async () => {
  const old = new Date(Date.now() - 20 * 60_000).toISOString();
  renderFleet(
    <OtaPanel
      device={device({ otaState: { phase: 'in_progress', updatedAt: old } })}
      onDeviceChange={() => {}}
    />,
    { api: { listFirmware: async () => listing, sendCommand: vi.fn(async () => ({})) } },
  );
  expect(await screen.findByText(/No word from the device since/)).toBeInTheDocument();
});

test('polls get_version while an update is in flight', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const sendCommand = vi.fn(async () => ({}));
  renderFleet(
    <OtaPanel
      device={device({ otaState: { phase: 'in_progress', updatedAt: new Date().toISOString() } })}
      onDeviceChange={() => {}}
    />,
    { api: { listFirmware: async () => listing, sendCommand } },
  );
  await act(async () => {
    vi.advanceTimersByTime(31_000);
  });
  expect(sendCommand).toHaveBeenCalledWith('BootBootsThing', { command: 'get_version' });
  vi.useRealTimers();
});

test('explains when there is nothing a signed-only device can take', async () => {
  renderFleet(<OtaPanel device={device({ capabilities: ['ota-signed'] })} onDeviceChange={() => {}} />, {
    api: { listFirmware: async () => ({ ...listing, versions: [] }) },
  });
  expect(await screen.findByText('No signed builds published for this project.')).toBeInTheDocument();
});

test('surfaces API refusals', async () => {
  renderFleet(<OtaPanel device={device()} onDeviceChange={() => {}} />, {
    api: {
      listFirmware: async () => listing,
      startOta: async () => Promise.reject(new Error('only accepts signed firmware')),
    },
  });
  await userEvent.click(await screen.findByRole('button', { name: 'Update to 1.0.331' }));
  expect(await screen.findByText('only accepts signed firmware')).toBeInTheDocument();
});
