import { formatBytes, isOnline, isStuck, quietLimitMs, relativeTime } from './format';

const NOW = Date.parse('2026-10-11T18:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

test('online means seen in the last 2.5 minutes', () => {
  expect(isOnline(ago(60_000), NOW)).toBe(true);
  expect(isOnline(ago(200_000), NOW)).toBe(false);
  expect(isOnline(undefined, NOW)).toBe(false);
});

test('Kata counts as online for 10 minutes: she is silent through a long pass (CHATS-13)', () => {
  expect(isOnline(ago(6 * 60_000), NOW, 'kata')).toBe(true);
  expect(isOnline(ago(11 * 60_000), NOW, 'kata')).toBe(false);
  // Every other project keeps 2.5 minutes.
  expect(isOnline(ago(6 * 60_000), NOW, 'bootboots')).toBe(false);
  expect(isOnline(ago(6 * 60_000), NOW)).toBe(false);
});

test.each([
  [undefined, 'never'],
  [ago(-5000), 'just now'],
  [ago(30_000), '30s ago'],
  [ago(5 * 60_000), '5m ago'],
  [ago(3 * 3600_000), '3h ago'],
  [ago(5 * 86400_000), '5d ago'],
])('relativeTime(%s) = %s', (iso, expected) => {
  expect(relativeTime(iso, NOW)).toBe(expected);
});

test('formatBytes', () => {
  expect(formatBytes(512)).toBe('512 B');
  expect(formatBytes(2048)).toBe('2.0 KB');
  expect(formatBytes(3 * 1024 * 1024)).toBe('3.00 MB');
});

test('approval gets at least 15 minutes and other phases 10 before an update is called stuck', () => {
  expect(quietLimitMs('awaiting_approval')).toBeGreaterThanOrEqual(15 * 60_000);
  expect(quietLimitMs('in_progress')).toBe(10 * 60_000);
  expect(isStuck({ phase: 'awaiting_approval', updatedAt: ago(12 * 60_000) }, NOW)).toBe(false);
  expect(isStuck({ phase: 'in_progress', updatedAt: ago(12 * 60_000) }, NOW)).toBe(true);
  expect(isStuck({ phase: 'complete', updatedAt: ago(99 * 60_000) }, NOW)).toBe(false);
  expect(isStuck(undefined, NOW)).toBe(false);
});
