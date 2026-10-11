import { getEntry, scanEntries } from './registry';
import { describeThing, listThings, parseCapabilities, type ThingSummary } from './things';
import type { Device, HwType, RegistryEntry } from './types';

/** Registry values win over Thing attributes (they are edited in Fleet); the Thing fills the gaps. */
export function mergeDevice(deviceId: string, entry: RegistryEntry | undefined, thing: ThingSummary | undefined): Device {
  const attrs = thing?.attributes ?? {};
  return {
    ...entry,
    deviceId,
    project: entry?.project ?? attrs.project ?? 'unassigned',
    deviceType: entry?.deviceType ?? attrs.deviceType,
    hwType: entry?.hwType ?? (attrs.hwType as HwType | undefined),
    capabilities: entry?.capabilities ?? parseCapabilities(attrs.capabilities),
    hasThing: Boolean(thing),
    registered: Boolean(entry),
  };
}

export async function listDevices(): Promise<Device[]> {
  const [things, entries] = await Promise.all([listThings(), scanEntries()]);
  const byId = new Map<string, { entry?: RegistryEntry; thing?: ThingSummary }>();
  for (const thing of things) byId.set(thing.thingName, { thing });
  for (const entry of entries) byId.set(entry.deviceId, { ...byId.get(entry.deviceId), entry });
  return [...byId.entries()]
    .map(([id, { entry, thing }]) => mergeDevice(id, entry, thing))
    .sort((a, b) => a.project.localeCompare(b.project) || a.deviceId.localeCompare(b.deviceId));
}

export async function getDevice(deviceId: string): Promise<Device | undefined> {
  const [entry, thing] = await Promise.all([getEntry(deviceId), describeThing(deviceId)]);
  if (!entry && !thing) return undefined;
  return mergeDevice(deviceId, entry, thing);
}

export const hasCapability = (device: Device, capability: string) => device.capabilities.includes(capability);
