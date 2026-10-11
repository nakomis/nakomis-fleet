import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Device } from '../api/types';
import { fakeLive, renderFleet } from '../test/render';
import { DevicePage } from './DevicePage';

const device: Device = {
  deviceId: 'BootBootsThing',
  project: 'bootboots',
  firmwareProject: 'BootBoots',
  deviceType: 'bootboots',
  hwType: 'esp32',
  capabilities: ['photos', 'logs'],
  hasThing: true,
  registered: true,
  currentVersion: '1.0.330',
  lastSeen: new Date().toISOString(),
};

function setup(overrides: Record<string, unknown> = {}) {
  const live = fakeLive();
  const api = {
    getDevice: vi.fn(async () => device),
    listFirmware: vi.fn(async () => ({ env: 'sandbox', project: 'BootBoots', versions: [], promotable: [] })),
    sendCommand: vi.fn(async () => ({})),
    updateDevice: vi.fn(async (_id: string, u: object) => ({ ...device, ...u })),
    wipe: vi.fn(async (_id: string, project: string) => ({ ...device, project })),
    ...overrides,
  };
  renderFleet(<DevicePage />, {
    api,
    live: live.live,
    path: '/devices/BootBootsThing',
    route: '/devices/:id',
  });
  return { api, ...live };
}

test('shows the device and its panels', async () => {
  setup();
  expect(await screen.findByText('online')).toBeInTheDocument();
  expect(screen.getByText(/Running 1.0.330/)).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Commands' })).toBeInTheDocument();
  expect(screen.getByLabelText('Firmware project')).toHaveValue('BootBoots');
});

test('sends commands and confirms before rebooting', async () => {
  const { api } = setup();
  await userEvent.click(await screen.findByRole('button', { name: 'Get version' }));
  expect(api.sendCommand).toHaveBeenCalledWith('BootBootsThing', { command: 'get_version' });

  await userEvent.click(screen.getByRole('button', { name: 'Reboot' }));
  const dialog = await screen.findByRole('dialog');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Reboot' }));
  expect(api.sendCommand).toHaveBeenCalledWith('BootBootsThing', { command: 'reboot' });
});

test('logs live messages for this device only', async () => {
  const { emit } = setup();
  await screen.findByText('online');
  act(() => {
    emit({
      type: 'deviceMessage',
      deviceId: 'BootBootsThing',
      project: 'bootboots',
      channel: 'responses',
      message: { type: 'pong', timestamp: 1 },
      device: { deviceId: 'BootBootsThing' },
    });
    emit({
      type: 'deviceMessage',
      deviceId: 'Other',
      project: 'x',
      channel: 'responses',
      message: { type: 'other' },
      device: { deviceId: 'Other' },
    });
  });
  expect(screen.getByText(/"type":"pong"/)).toBeInTheDocument();
  expect(screen.queryByText(/"type":"other"/)).not.toBeInTheDocument();
});

test('saves settings, splitting capabilities', async () => {
  const { api } = setup();
  const caps = await screen.findByLabelText('Capabilities');
  await userEvent.clear(caps);
  await userEvent.type(caps, 'ota, ota-signed');
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(api.updateDevice).toHaveBeenCalledWith(
    'BootBootsThing',
    expect.objectContaining({ capabilities: ['ota', 'ota-signed'], firmwareProject: 'BootBoots' }),
  );
  expect(await screen.findByText('Saved')).toBeInTheDocument();
});

test('wipe is only offered to devices that can wipe', async () => {
  setup();
  expect(await screen.findByRole('button', { name: 'Wipe and re-purpose…' })).toBeDisabled();
});

test('wipes and re-purposes', async () => {
  const { api } = setup({ getDevice: vi.fn(async () => ({ ...device, capabilities: ['wipe'] })) });
  await userEvent.click(await screen.findByRole('button', { name: 'Wipe and re-purpose…' }));
  const dialog = await screen.findByRole('dialog');
  await userEvent.type(within(dialog).getByLabelText('New project'), 'kappawarmer');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Wipe' }));
  expect(api.wipe).toHaveBeenCalledWith('BootBootsThing', 'kappawarmer');
  expect(await screen.findByText(/now belongs to kappawarmer/)).toBeInTheDocument();
});

test('reports unknown devices', async () => {
  setup({ getDevice: vi.fn(async () => Promise.reject(new Error('Unknown device BootBootsThing'))) });
  expect(await screen.findByText('Unknown device BootBootsThing')).toBeInTheDocument();
});
