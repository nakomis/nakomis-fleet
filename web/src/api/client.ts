import type { DeployEnv, ShellContext } from '../shell-contract';
import type { Device, DeviceUpdate, FirmwareListing, OtaStarted, ProjectSummary } from './types';

const ZONES: Record<DeployEnv, string> = { sandbox: 'sandbox.nakomis.com', prod: 'nakomis.com' };
export const apiBase = (env: DeployEnv) => `https://api.fleet.${ZONES[env]}`;
export const wsBase = (env: DeployEnv) => `wss://ws.fleet.${ZONES[env]}`;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type FleetApi = ReturnType<typeof createFleetApi>;

export function createFleetApi(
  shell: Pick<ShellContext, 'env' | 'getAccessToken'>,
  fetchImpl: typeof fetch = fetch,
) {
  const base = apiBase(shell.env);

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await shell.getAccessToken();
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : undefined;
    if (!res.ok)
      throw new ApiError(
        res.status,
        data?.error ?? data?.message ?? `${method} ${path} failed (${res.status})`,
      );
    return data as T;
  }

  const enc = encodeURIComponent;

  return {
    listDevices: () => call<{ devices: Device[] }>('GET', '/devices').then((r) => r.devices),
    getDevice: (id: string) => call<Device>('GET', `/devices/${enc(id)}`),
    updateDevice: (id: string, update: DeviceUpdate) => call<Device>('PUT', `/devices/${enc(id)}`, update),
    startOta: (id: string, version: string) =>
      call<OtaStarted>('POST', `/devices/${enc(id)}/ota`, { version }),
    cancelOta: (id: string) => call<unknown>('POST', `/devices/${enc(id)}/ota/cancel`),
    sendCommand: (id: string, command: Record<string, unknown>) =>
      call<unknown>('POST', `/devices/${enc(id)}/command`, command),
    wipe: (id: string, project: string) => call<Device>('POST', `/devices/${enc(id)}/wipe`, { project }),
    listProjects: () => call<{ env: string; projects: ProjectSummary[] }>('GET', '/projects'),
    listFirmware: (project: string, deviceId?: string) =>
      call<FirmwareListing>(
        'GET',
        `/projects/${enc(project)}/firmware${deviceId ? `?deviceId=${enc(deviceId)}` : ''}`,
      ),
    firmwareUrl: (project: string, version: string) =>
      call<{ url: string; expiresIn: number; sha256?: string; signed: boolean }>(
        'GET',
        `/projects/${enc(project)}/firmware/${enc(version)}/url`,
      ),
    promote: (project: string, version: string) =>
      call<unknown>('POST', `/projects/${enc(project)}/firmware/${enc(version)}/promote`),
  };
}
