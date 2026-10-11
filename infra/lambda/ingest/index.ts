import { broadcast } from '../shared/connections';
import { getEntry, updateEntry } from '../shared/registry';
import type { OtaPhase, OtaState, RegistryEntry } from '../shared/types';

/**
 * IoT rule target for {project}/{deviceId}/responses and /status. Keeps the registry's lastSeen,
 * currentVersion and otaState current, then forwards the message to every open Fleet UI.
 */
export interface DeviceMessage {
  project: string;
  deviceId: string;
  channel: 'responses' | 'status';
  receivedAt?: number;
  type?: string;
  [key: string]: unknown;
}

const OTA_STATUSES: Record<string, OtaPhase> = {
  awaiting_approval: 'awaiting_approval',
  approved: 'approved',
};

export function otaStateFrom(message: DeviceMessage, previous: OtaState | undefined, at: string): OtaState | undefined {
  const targetVersion = (message.version as string | undefined) ?? previous?.targetVersion;
  switch (message.type) {
    case 'ota_progress': {
      const status = typeof message.status === 'string' ? message.status : undefined;
      const phase: OtaPhase =
        (status ? OTA_STATUSES[status] : undefined) ?? (status === 'Update cancelled' ? 'cancelled' : 'in_progress');
      return { phase, targetVersion, progress: Number(message.progress ?? 0), status, updatedAt: at };
    }
    case 'ota_complete':
      return { phase: 'complete', targetVersion, progress: 100, updatedAt: at };
    case 'ota_error': {
      const text = String(message.message ?? 'unknown error');
      return { phase: text === 'rolled back' ? 'rolled_back' : 'error', targetVersion, message: text, updatedAt: at };
    }
    case 'version':
      // Devices don't send ota_complete (they reboot), so reaching the target version is completion.
      if (previous && previous.phase !== 'complete' && previous.targetVersion === message.version) {
        return { phase: 'complete', targetVersion: previous.targetVersion, progress: 100, updatedAt: at };
      }
      return undefined;
    default:
      return undefined;
  }
}

export function registryUpdate(message: DeviceMessage, existing: RegistryEntry | undefined, at: string): Partial<RegistryEntry> {
  const update: Partial<RegistryEntry> = { lastSeen: at };
  // A device publishing under a project is the best evidence of its project; don't override an edited one.
  if (!existing?.project) update.project = message.project;
  if (message.channel === 'status') {
    const { project: _p, deviceId: _d, channel: _c, receivedAt: _r, ...status } = message;
    update.lastStatus = status;
  }
  if ((message.type === 'version' || message.type === 'ota_complete') && typeof message.version === 'string') {
    update.currentVersion = message.version;
  }
  const otaState = otaStateFrom(message, existing?.otaState, at);
  if (otaState) update.otaState = otaState;
  return update;
}

export const handler = async (message: DeviceMessage): Promise<void> => {
  if (!message?.deviceId || !message.project) {
    console.warn('Ignoring message without topic metadata', message);
    return;
  }
  const at = new Date(message.receivedAt ?? Date.now()).toISOString();
  const existing = await getEntry(message.deviceId);
  const device = await updateEntry(message.deviceId, registryUpdate(message, existing, at));
  await broadcast({ type: 'deviceMessage', deviceId: message.deviceId, project: message.project, channel: message.channel, message, device });
};
