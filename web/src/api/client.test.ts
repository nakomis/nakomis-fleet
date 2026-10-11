import { ApiError, apiBase, createFleetApi, wsBase } from './client';

test('env picks the API hosts', () => {
  expect(apiBase('sandbox')).toBe('https://api.fleet.sandbox.nakomis.com');
  expect(apiBase('prod')).toBe('https://api.fleet.nakomis.com');
  expect(wsBase('prod')).toBe('wss://ws.fleet.nakomis.com');
});

test('sends the bearer token and JSON body', async () => {
  const fetchMock = vi.fn(
    async () => new Response(JSON.stringify({ deviceId: 'd', otaState: {} }), { status: 202 }),
  );
  const api = createFleetApi({ env: 'sandbox', getAccessToken: async () => 'tok' }, fetchMock);

  await api.startOta('a b', '1.0.0');

  expect(fetchMock).toHaveBeenCalledWith('https://api.fleet.sandbox.nakomis.com/devices/a%20b/ota', {
    method: 'POST',
    headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
    body: '{"version":"1.0.0"}',
  });
});

test('turns error bodies into ApiError', async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'nope' }), { status: 409 }));
  const api = createFleetApi({ env: 'sandbox', getAccessToken: async () => 'tok' }, fetchMock);

  await expect(api.listDevices()).rejects.toEqual(new ApiError(409, 'nope'));
});

test('builds query strings for firmware listings', async () => {
  const fetchMock = vi.fn(async () => new Response('{"versions":[]}'));
  const api = createFleetApi({ env: 'prod', getAccessToken: async () => 't' }, fetchMock);
  await api.listFirmware('BootBoots', 'BootBootsThing');
  expect((fetchMock.mock.calls[0] as unknown[])[0]).toBe(
    'https://api.fleet.nakomis.com/projects/BootBoots/firmware?deviceId=BootBootsThing',
  );
});
