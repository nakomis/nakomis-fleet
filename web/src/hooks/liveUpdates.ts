import { wsBase } from '../api/client';
import type { DeviceMessageEvent } from '../api/types';
import type { DeployEnv } from '../shell-contract';

type Listener = (event: DeviceMessageEvent) => void;
export type LiveStatus = 'connecting' | 'live' | 'offline';

const PING_MS = 5 * 60 * 1000; // API Gateway drops idle WebSockets after 10 minutes.
const MAX_BACKOFF_MS = 30_000;

/**
 * One WebSocket per Fleet mount, shared by every page. Reconnects with backoff and a fresh token
 * (API Gateway also closes connections after two hours).
 */
export class LiveUpdates {
  private socket?: WebSocket;
  private listeners = new Set<Listener>();
  private statusListeners = new Set<(s: LiveStatus) => void>();
  private attempt = 0;
  private stopped = false;
  private ping?: ReturnType<typeof setInterval>;
  private retry?: ReturnType<typeof setTimeout>;
  status: LiveStatus = 'connecting';

  constructor(
    private readonly env: DeployEnv,
    private readonly getToken: () => Promise<string>,
    private readonly createSocket: (url: string) => WebSocket = (url) => new WebSocket(url),
  ) {}

  start() {
    this.stopped = false;
    void this.connect();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.ping);
    clearTimeout(this.retry);
    this.socket?.close();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  onStatus(listener: (s: LiveStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  private setStatus(status: LiveStatus) {
    this.status = status;
    for (const l of this.statusListeners) l(status);
  }

  private async connect() {
    if (this.stopped) return;
    this.setStatus('connecting');
    let token: string;
    try {
      token = await this.getToken();
    } catch {
      this.scheduleReconnect();
      return;
    }
    if (this.stopped) return;
    const socket = this.createSocket(`${wsBase(this.env)}?token=${encodeURIComponent(token)}`);
    this.socket = socket;
    socket.onopen = () => {
      this.attempt = 0;
      this.setStatus('live');
      clearInterval(this.ping);
      this.ping = setInterval(() => socket.send(JSON.stringify({ action: 'ping' })), PING_MS);
    };
    socket.onmessage = (msg) => {
      try {
        const event = JSON.parse(String(msg.data)) as DeviceMessageEvent;
        if (event.type === 'deviceMessage') for (const l of this.listeners) l(event);
      } catch {
        // pong and other non-JSON frames
      }
    };
    socket.onclose = () => {
      clearInterval(this.ping);
      if (this.socket === socket) this.scheduleReconnect();
    };
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    this.setStatus('offline');
    const delay = Math.min(1000 * 2 ** this.attempt++, MAX_BACKOFF_MS);
    this.retry = setTimeout(() => void this.connect(), delay);
  }
}
