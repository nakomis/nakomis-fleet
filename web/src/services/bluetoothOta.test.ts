import { bleOtaPackets } from './bluetoothOta';

const decode = (p: Uint8Array) => JSON.parse(new TextDecoder().decode(p));

test('short URLs fit in one ota_update packet', () => {
  const packets = bleOtaPackets('https://x/fw.bin', '1.0.0');
  expect(packets.map(decode)).toEqual([
    { action: 'ota_update', firmware_url: 'https://x/fw.bin', version: '1.0.0' },
  ]);
});

test('long presigned URLs are chunked under the BLE packet limit and reassemble', () => {
  const url = `https://bucket/fw.bin?X-Amz-Security-Token=${'t'.repeat(1300)}`;
  const packets = bleOtaPackets(url, '1.0.0');
  expect(packets.length).toBeGreaterThan(1);
  for (const p of packets) expect(p.length).toBeLessThanOrEqual(512);
  expect(packets.map((p) => decode(p).chunk_data).join('')).toBe(url);
});
