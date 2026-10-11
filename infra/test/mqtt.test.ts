import { MAX_URL_CHUNKS, otaMessages, URL_CHUNK_SIZE } from '../lambda/shared/mqtt';

test('short URLs go in a single ota_update', () => {
  expect(otaMessages('https://x/fw.bin', '1.0.0')).toEqual([{ command: 'ota_update', url: 'https://x/fw.bin', version: '1.0.0' }]);
});

test('long URLs are split into url_chunk messages that reassemble', () => {
  const url = `https://bucket.s3.eu-west-2.amazonaws.com/fw.bin?X-Amz-Security-Token=${'t'.repeat(1400)}`;
  const messages = otaMessages(url, '1.0.0');
  expect(messages.length).toBe(Math.ceil(url.length / URL_CHUNK_SIZE));
  expect(messages.every((m) => m.command === 'url_chunk' && m.total_chunks === messages.length && m.version === '1.0.0')).toBe(true);
  expect(messages.map((m) => m.chunk_data).join('')).toBe(url);
  expect(messages.map((m) => m.chunk_index)).toEqual(messages.map((_, i) => i));
});

test('refuses URLs the device could not reassemble', () => {
  expect(() => otaMessages(`https://x/${'a'.repeat(URL_CHUNK_SIZE * MAX_URL_CHUNKS)}`, '1.0.0')).toThrow(/too long/);
});
