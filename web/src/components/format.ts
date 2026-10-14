import type { OtaPhase, OtaState } from '../api/types';

/** A device that published in the last 2½ minutes counts as online (status heartbeats are every 60 s). */
export const ONLINE_WINDOW_MS = 150_000;

/**
 * Projects whose devices go quiet for longer in normal running. Kata (claude-chats CHATS-13) has
 * no MQTT: she publishes her status over HTTPS after each SQS phase, so a long embedding pass
 * leaves her silent for up to ~5 minutes.
 */
export const PROJECT_ONLINE_WINDOW_MS: Record<string, number> = {
  kata: 10 * 60_000,
};

export function onlineWindowMs(project?: string): number {
  return (project && PROJECT_ONLINE_WINDOW_MS[project]) || ONLINE_WINDOW_MS;
}

export function isOnline(lastSeen: string | undefined, now = Date.now(), project?: string) {
  return Boolean(lastSeen) && now - Date.parse(lastSeen!) < onlineWindowMs(project);
}

export function relativeTime(iso: string | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const seconds = Math.round((now - Date.parse(iso)) / 1000);
  if (seconds < 0) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export const OTA_LABELS: Record<OtaPhase, string> = {
  requested: 'Update sent',
  in_progress: 'Updating',
  awaiting_approval: 'Awaiting approval on device',
  approved: 'Approved, installing',
  complete: 'Up to date',
  error: 'Update failed',
  rolled_back: 'Rolled back',
  cancelled: 'Cancelled',
};

export const ACTIVE_PHASES: OtaPhase[] = ['requested', 'in_progress', 'awaiting_approval', 'approved'];

/**
 * How long without news before the UI calls an update stuck. Approval waits for a human, so it gets longer.
 * Never shorter than 10 minutes: approval-gated devices can legitimately take that long.
 */
export function quietLimitMs(phase: OtaPhase) {
  return phase === 'awaiting_approval' ? 15 * 60_000 : 10 * 60_000;
}

export function isStuck(state: OtaState | undefined, now = Date.now()) {
  if (!state || !ACTIVE_PHASES.includes(state.phase)) return false;
  return now - Date.parse(state.updatedAt) > quietLimitMs(state.phase);
}

export function otaColour(phase: OtaPhase): 'default' | 'info' | 'success' | 'warning' | 'error' {
  if (phase === 'complete') return 'success';
  if (phase === 'error' || phase === 'rolled_back') return 'error';
  if (phase === 'awaiting_approval') return 'warning';
  if (phase === 'cancelled') return 'default';
  return 'info';
}
