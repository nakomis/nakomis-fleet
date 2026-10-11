import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getDevice, hasCapability, listDevices, mergeDevice } from '../shared/devices';
import {
  findVersion,
  getManifest,
  listFirmwareProjects,
  PRESIGN_SECONDS,
  presignFirmware,
  promoteFromSandbox,
  resolveFirmwareProject,
  sandboxManifest,
} from '../shared/firmware';
import { assertId, assertVersion, HttpError, json, parseBody } from '../shared/http';
import { otaMessages, publishCommand } from '../shared/mqtt';
import { updateEntry } from '../shared/registry';
import { setThingAttributes } from '../shared/things';
import type { Device, HwType, Manifest, OtaState } from '../shared/types';

type Event = APIGatewayProxyEventV2WithJWTAuthorizer;

// Commands that must go through the OTA endpoint so capability checks can't be bypassed.
const RESERVED_COMMANDS = new Set(['ota_update', 'url_chunk']);
const HW_TYPES: HwType[] = ['esp32', 'pi', 'unknown'];

const now = () => new Date().toISOString();

async function requireDevice(event: Event): Promise<Device> {
  const deviceId = assertId(event.pathParameters?.id, 'device id');
  const device = await getDevice(deviceId);
  if (!device) throw new HttpError(404, `Unknown device ${deviceId}`);
  return device;
}

async function requireFirmwareProject(device: Device): Promise<string> {
  const firmwareProject = await resolveFirmwareProject(device.project, device.firmwareProject);
  if (!firmwareProject) throw new HttpError(404, `No firmware published for project ${device.project}`);
  return firmwareProject;
}

/** Hides builds a device must not be offered: unsigned builds for signed-only devices. */
export function eligibleVersions(device: Device, manifest: Manifest | undefined) {
  const versions = manifest?.versions ?? [];
  return hasCapability(device, 'ota-signed') ? versions.filter((v) => v.signed) : versions;
}

async function startOta(event: Event): Promise<APIGatewayProxyResultV2> {
  const device = await requireDevice(event);
  const { version: rawVersion } = parseBody<{ version?: string }>(event.body, event.isBase64Encoded);
  const version = assertVersion(rawVersion);
  if (device.hwType === 'pi' && !hasCapability(device, 'ota')) {
    throw new HttpError(409, `${device.deviceId} has no OTA agent`);
  }
  const firmwareProject = await requireFirmwareProject(device);
  const entry = await findVersion(firmwareProject, version);
  if (hasCapability(device, 'ota-signed') && !entry.signed) {
    throw new HttpError(409, `${device.deviceId} only accepts signed firmware; ${version} is unsigned`);
  }

  const url = await presignFirmware(entry);
  for (const message of otaMessages(url, version)) {
    await publishCommand(device.project, device.deviceId, message);
  }
  const otaState: OtaState = { phase: 'requested', targetVersion: version, updatedAt: now() };
  await updateEntry(device.deviceId, { otaState, project: device.project });
  return json(202, {
    deviceId: device.deviceId,
    otaState,
    sha256: entry.sha256,
    signed: entry.signed ?? false,
    awaitsApproval: hasCapability(device, 'ota-approval'),
  });
}

async function cancelOta(event: Event): Promise<APIGatewayProxyResultV2> {
  const device = await requireDevice(event);
  await publishCommand(device.project, device.deviceId, { command: 'ota_cancel' });
  const otaState: OtaState = { ...device.otaState, phase: 'cancelled', updatedAt: now() };
  await updateEntry(device.deviceId, { otaState });
  return json(202, { deviceId: device.deviceId, otaState });
}

async function sendCommand(event: Event): Promise<APIGatewayProxyResultV2> {
  const device = await requireDevice(event);
  const body = parseBody<Record<string, unknown>>(event.body, event.isBase64Encoded);
  if (typeof body.command !== 'string' || !body.command) throw new HttpError(400, 'command is required');
  if (RESERVED_COMMANDS.has(body.command)) throw new HttpError(400, `Use the OTA endpoint for ${body.command}`);
  await publishCommand(device.project, device.deviceId, body);
  return json(202, { deviceId: device.deviceId, sent: body });
}

async function updateDevice(event: Event): Promise<APIGatewayProxyResultV2> {
  const deviceId = assertId(event.pathParameters?.id, 'device id');
  const body = parseBody<{
    project?: string;
    firmwareProject?: string;
    deviceType?: string;
    hwType?: HwType;
    capabilities?: string[];
    notes?: string;
  }>(event.body, event.isBase64Encoded);

  if (body.project !== undefined) assertId(body.project, 'project');
  if (body.firmwareProject !== undefined && body.firmwareProject !== '') assertId(body.firmwareProject, 'firmwareProject');
  if (body.hwType !== undefined && !HW_TYPES.includes(body.hwType)) throw new HttpError(400, 'Invalid hwType');
  if (body.capabilities !== undefined) {
    if (!Array.isArray(body.capabilities) || body.capabilities.some((c) => typeof c !== 'string' || c.includes(','))) {
      throw new HttpError(400, 'capabilities must be an array of strings without commas');
    }
  }
  if (body.notes !== undefined && (typeof body.notes !== 'string' || body.notes.length > 2000)) {
    throw new HttpError(400, 'notes must be a string of at most 2000 characters');
  }

  const existing = await getDevice(deviceId);
  const entry = await updateEntry(deviceId, {
    project: body.project,
    firmwareProject: body.firmwareProject,
    deviceType: body.deviceType,
    hwType: body.hwType,
    capabilities: body.capabilities,
    notes: body.notes,
  });

  // Keep the Thing in step so firmware and other tooling see the same project.
  if (existing?.hasThing) {
    const attributes: Record<string, string> = {};
    if (body.project !== undefined) attributes.project = body.project;
    if (body.deviceType !== undefined) attributes.deviceType = body.deviceType;
    if (body.capabilities !== undefined) attributes.capabilities = body.capabilities.join(',');
    if (Object.keys(attributes).length > 0) await setThingAttributes(deviceId, attributes);
  }
  return json(200, (await getDevice(deviceId)) ?? mergeDevice(deviceId, entry, undefined));
}

/** Wipe and re-purpose: ask the device to reset its NVS, then move it to another project. */
async function wipeDevice(event: Event): Promise<APIGatewayProxyResultV2> {
  const device = await requireDevice(event);
  const { project } = parseBody<{ project?: string }>(event.body, event.isBase64Encoded);
  const newProject = assertId(project, 'project');
  // Sent on the old topic: that's the one the device is listening on.
  await publishCommand(device.project, device.deviceId, { command: 'wipe', project: newProject });
  await updateEntry(device.deviceId, {
    project: newProject,
    firmwareProject: '',
    currentVersion: '',
    otaState: { phase: 'cancelled', message: `Wiped and moved to ${newProject}`, updatedAt: now() },
  });
  if (device.hasThing) await setThingAttributes(device.deviceId, { project: newProject });
  return json(202, await getDevice(device.deviceId));
}

async function listProjects(): Promise<APIGatewayProxyResultV2> {
  const names = await listFirmwareProjects();
  const manifests = await Promise.all(names.map((p) => getManifest(p)));
  const projects = names
    .map((name, i) => ({ name, manifest: manifests[i] }))
    .filter(({ manifest }) => manifest && !manifest.internal)
    .map(({ name, manifest }) => ({
      name,
      latest: manifest!.versions[0]?.version,
      versions: manifest!.versions.length,
      artefactType: manifest!.artefactType ?? 'bin',
    }));
  return json(200, { env: process.env.DEPLOY_ENV, projects });
}

async function listFirmware(event: Event): Promise<APIGatewayProxyResultV2> {
  const project = assertId(event.pathParameters?.project, 'project');
  const deviceId = event.queryStringParameters?.deviceId;
  let firmwareProject = project;
  let device: Device | undefined;
  if (deviceId) {
    device = await getDevice(assertId(deviceId, 'device id'));
    if (!device) throw new HttpError(404, `Unknown device ${deviceId}`);
    firmwareProject = (await resolveFirmwareProject(device.project, device.firmwareProject)) ?? project;
  } else {
    firmwareProject = (await resolveFirmwareProject(project)) ?? project;
  }
  const manifest = await getManifest(firmwareProject);
  const versions = device ? eligibleVersions(device, manifest) : (manifest?.versions ?? []);
  const sandbox = await sandboxManifest(firmwareProject);
  return json(200, {
    env: process.env.DEPLOY_ENV,
    project: firmwareProject,
    versions,
    // In prod, builds that exist in sandbox but haven't been promoted yet.
    promotable: sandbox?.versions.filter((v) => !manifest?.versions.some((m) => m.version === v.version)) ?? [],
  });
}

async function firmwareUrl(event: Event): Promise<APIGatewayProxyResultV2> {
  const project = assertId(event.pathParameters?.project, 'project');
  const version = assertVersion(event.pathParameters?.version);
  const firmwareProject = (await resolveFirmwareProject(project)) ?? project;
  const entry = await findVersion(firmwareProject, version);
  return json(200, { url: await presignFirmware(entry), expiresIn: PRESIGN_SECONDS, sha256: entry.sha256, signed: entry.signed ?? false });
}

async function promote(event: Event): Promise<APIGatewayProxyResultV2> {
  const project = assertId(event.pathParameters?.project, 'project');
  const version = assertVersion(event.pathParameters?.version);
  await promoteFromSandbox(project, version);
  return json(202, { project, version, promoted: true });
}

const routes: Record<string, (event: Event) => Promise<APIGatewayProxyResultV2>> = {
  'GET /devices': async () => json(200, { devices: await listDevices() }),
  'GET /devices/{id}': async (e) => json(200, await requireDevice(e)),
  'PUT /devices/{id}': updateDevice,
  'POST /devices/{id}/ota': startOta,
  'POST /devices/{id}/ota/cancel': cancelOta,
  'POST /devices/{id}/command': sendCommand,
  'POST /devices/{id}/wipe': wipeDevice,
  'GET /projects': listProjects,
  'GET /projects/{project}/firmware': listFirmware,
  'GET /projects/{project}/firmware/{version}/url': firmwareUrl,
  'POST /projects/{project}/firmware/{version}/promote': promote,
};

export const handler = async (event: Event): Promise<APIGatewayProxyResultV2> => {
  const route = routes[event.routeKey];
  if (!route) return json(404, { error: `No route ${event.routeKey}` });
  try {
    return await route(event);
  } catch (err) {
    if (err instanceof HttpError) return json(err.statusCode, { error: err.message });
    console.error(`${event.routeKey} failed`, err);
    return json(500, { error: 'Internal error' });
  }
};
