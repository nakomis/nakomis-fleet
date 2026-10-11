import { act, screen } from '@testing-library/react';
import type { Device } from '../api/types';
import { fakeLive, renderFleet } from '../test/render';
import { DevicesPage, mergeLive } from './DevicesPage';

const devices: Device[] = [
  {
    deviceId: 'BootBootsThing',
    project: 'bootboots',
    capabilities: ['photos'],
    hasThing: true,
    registered: true,
    currentVersion: '1.0.330',
    lastSeen: new Date().toISOString(),
  },
  {
    deviceId: 'tinycrypt-sandbox-key-1',
    project: 'tinycrypt',
    capabilities: ['ota', 'ota-signed'],
    hasThing: true,
    registered: true,
    otaState: { phase: 'awaiting_approval', targetVersion: '0.3.0', updatedAt: new Date().toISOString() },
  },
];

test('lists devices with version, signed-only badge and OTA state', async () => {
  renderFleet(<DevicesPage />, { api: { listDevices: async () => devices } });

  expect(await screen.findByRole('link', { name: 'BootBootsThing' })).toHaveAttribute(
    'href',
    '/devices/BootBootsThing',
  );
  expect(screen.getByText('1.0.330')).toBeInTheDocument();
  expect(screen.getByText('signed only')).toBeInTheDocument();
  expect(screen.getByText('Awaiting approval on device → 0.3.0')).toBeInTheDocument();
  expect(screen.getByLabelText('online')).toBeInTheDocument();
});

test('applies live updates as they arrive', async () => {
  const { live, emit } = fakeLive();
  renderFleet(<DevicesPage />, { api: { listDevices: async () => devices }, live });
  await screen.findByText('1.0.330');

  act(() =>
    emit({
      type: 'deviceMessage',
      deviceId: 'BootBootsThing',
      project: 'bootboots',
      channel: 'responses',
      message: { type: 'version', version: '1.0.331' },
      device: { deviceId: 'BootBootsThing', currentVersion: '1.0.331' },
    }),
  );

  expect(await screen.findByText('1.0.331')).toBeInTheDocument();
});

test('shows load errors', async () => {
  renderFleet(<DevicesPage />, { api: { listDevices: async () => Promise.reject(new Error('403')) } });
  expect(await screen.findByText('Could not load devices: 403')).toBeInTheDocument();
});

test('mergeLive adds devices it has not seen before', () => {
  const merged = mergeLive([], {
    type: 'deviceMessage',
    deviceId: 'new-1',
    project: 'pish',
    channel: 'status',
    message: {},
    device: { deviceId: 'new-1', lastSeen: 'now' },
  });
  expect(merged).toEqual([expect.objectContaining({ deviceId: 'new-1', project: 'pish', capabilities: [] })]);
});
