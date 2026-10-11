import { render, screen } from '@testing-library/react';
import ShellApp from './ShellApp';
import { shell } from './test/render';

vi.mock('./hooks/liveUpdates', () => ({
  LiveUpdates: class {
    status = 'connecting';
    start() {}
    stop() {}
    subscribe() {
      return () => {};
    }
    onStatus() {
      return () => {};
    }
  },
}));

test('mounts under the shell basePath with its own router and tabs', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ devices: [] }))),
  );
  window.history.replaceState({}, '', '/fleet');
  render(<ShellApp {...shell} />);
  expect(screen.getByRole('tab', { name: 'Devices' })).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: 'Firmware' })).toHaveAttribute('href', '/fleet/firmware');
  expect(screen.getByText('Connecting…')).toBeInTheDocument();
  expect(await screen.findByText('No devices yet.')).toBeInTheDocument();
  vi.unstubAllGlobals();
});
