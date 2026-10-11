import { LiveUpdates } from './liveUpdates';

class FakeSocket {
  static last: FakeSocket;
  sent: string[] = [];
  onopen?: () => void;
  onmessage?: (m: { data: string }) => void;
  onclose?: () => void;
  constructor(readonly url: string) {
    FakeSocket.last = this;
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.onclose?.();
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

test('connects with the token, reports status and delivers device messages', async () => {
  const live = new LiveUpdates(
    'sandbox',
    async () => 'tok',
    (url) => new FakeSocket(url) as unknown as WebSocket,
  );
  const statuses: string[] = [];
  live.onStatus((s) => statuses.push(s));
  const got: unknown[] = [];
  live.subscribe((e) => got.push(e));

  live.start();
  await flush();
  expect(FakeSocket.last.url).toBe('wss://ws.fleet.sandbox.nakomis.com?token=tok');
  FakeSocket.last.onopen?.();
  FakeSocket.last.onmessage?.({ data: JSON.stringify({ type: 'deviceMessage', deviceId: 'd' }) });
  FakeSocket.last.onmessage?.({ data: 'pong' });

  expect(statuses).toEqual(['connecting', 'live']);
  expect(got).toEqual([{ type: 'deviceMessage', deviceId: 'd' }]);
  live.stop();
});

test('reconnects with backoff after the socket closes', async () => {
  vi.useFakeTimers();
  const tokens = vi.fn(async () => 'tok');
  const live = new LiveUpdates('prod', tokens, (url) => new FakeSocket(url) as unknown as WebSocket);
  live.start();
  await vi.advanceTimersByTimeAsync(0);
  const first = FakeSocket.last;
  first.onclose?.();
  expect(live.status).toBe('offline');

  await vi.advanceTimersByTimeAsync(1000);
  expect(FakeSocket.last).not.toBe(first);
  expect(tokens).toHaveBeenCalledTimes(2);
  live.stop();
  vi.useRealTimers();
});
