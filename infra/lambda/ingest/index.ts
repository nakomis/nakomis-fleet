import { broadcast } from '../shared/connections';
import { publishCommand } from '../shared/mqtt';
import { getEntry, updateEntry } from '../shared/registry';
import type { OtaPhase, OtaState, RegistryEntry } from '../shared/types';

/**
 * IoT rule target for {project}/{deviceId}/responses and /status. Keeps the registry's lastSeen,
 * currentVersion and otaState current, then forwards the message to every open Fleet UI.
 */
export interface DeviceMessage {
  // From the topic (aliased in the IoT rule so a device's own "project" field can't clash).
  topicProject: string;
  topicDeviceId: string;
  topicChannel: 'responses' | 'status';
  receivedAt?: number;
  type?: string;
  [key: string]: unknown;
}

const TOPIC_FIELDS = ['topicProject', 'topicDeviceId', 'topicChannel', 'receivedAt'];
export const payloadOf = (message: DeviceMessage) =>
  Object.fromEntries(Object.entries(message).filter(([k]) => !TOPIC_FIELDS.includes(k)));

const TERMINAL_PHASES = new Set<OtaPhase>(['complete', 'error', 'rolled_back', 'cancelled']);

const OTA_STATUSES: Record<string, OtaPhase> = {
  awaiting_approval: 'awaiting_approval',
  approved: 'approved',
};

export function otaStateFrom(message: DeviceMessage, previous: OtaState | undefined, at: string): OtaState | undefined {
  const targetVersion = (message.version as string | undefined) ?? previous?.targetVersion;
  switch (message.type) {
    case 'ota_progress': {
      // URL-chunk acks carry no version and can be delivered after the update has finished; they must not
      // reopen a finished update.
      if (message.version === undefined && previous && TERMINAL_PHASES.has(previous.phase)) return undefined;
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
  if (!existing?.project) update.project = message.topicProject;
  if (message.topicChannel === 'status') update.lastStatus = payloadOf(message);
  if ((message.type === 'version' || message.type === 'ota_complete') && typeof message.version === 'string') {
    update.currentVersion = message.version;
  }
  const otaState = otaStateFrom(message, existing?.otaState, at);
  if (otaState) update.otaState = otaState;
  return update;
}

const POLLED_PHASES = new Set(['requested', 'in_progress', 'approved']);

export const handler = async (message: DeviceMessage): Promise<void> => {
  const { topicProject: project, topicDeviceId: deviceId, topicChannel: channel } = message ?? {};
  if (!deviceId || !project) {
    console.warn('Ignoring message without topic metadata', message);
    return;
  }
  const at = new Date(message.receivedAt ?? Date.now()).toISOString();
  const existing = await getEntry(deviceId);
  const device = await updateEntry(deviceId, registryUpdate(message, existing, at));

  // Devices reboot into new firmware rather than sending ota_complete. A heartbeat during an update means
  // the device is up again, so ask which version it is running.
  if (channel === 'status' && device.otaState && POLLED_PHASES.has(device.otaState.phase)) {
    await publishCommand(project, deviceId, { command: 'get_version' }).catch((err) =>
      console.warn(`get_version to ${deviceId} failed`, err),
    );
  }

  await broadcast({ type: 'deviceMessage', deviceId, project, channel, message: payloadOf(message), device });
};
