import { ApiGatewayManagementApiClient, GoneException, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { type DeviceMessage, handler, otaStateFrom, registryUpdate } from '../lambda/ingest/index';

const ddb = mockClient(DynamoDBDocumentClient);
const ws = mockClient(ApiGatewayManagementApiClient);
const AT = '2026-10-11T17:00:00.000Z';

const msg = (fields: Partial<DeviceMessage>): DeviceMessage => ({ project: 'bootboots', deviceId: 'BootBootsThing', channel: 'responses', ...fields });

beforeEach(() => {
  ddb.reset();
  ws.reset();
  process.env.DEVICES_TABLE = 'devices';
  process.env.CONNECTIONS_TABLE = 'connections';
  process.env.WS_MANAGEMENT_ENDPOINT = 'https://ws.example/prod';
});

describe('otaStateFrom', () => {
  test.each([
    [{ type: 'ota_progress', progress: 40, status: 'Downloading', version: '1.2.3' }, { phase: 'in_progress', progress: 40, status: 'Downloading', targetVersion: '1.2.3' }],
    [{ type: 'ota_progress', progress: 0, status: 'awaiting_approval' }, { phase: 'awaiting_approval' }],
    [{ type: 'ota_progress', progress: 0, status: 'approved' }, { phase: 'approved' }],
    [{ type: 'ota_progress', progress: 0, status: 'Update cancelled' }, { phase: 'cancelled' }],
    [{ type: 'ota_complete', version: '1.2.3' }, { phase: 'complete', progress: 100 }],
    [{ type: 'ota_error', message: 'rejected' }, { phase: 'error', message: 'rejected' }],
    [{ type: 'ota_error', message: 'approval timed out' }, { phase: 'error', message: 'approval timed out' }],
    [{ type: 'ota_error', message: 'rolled back' }, { phase: 'rolled_back' }],
  ])('%j → %j', (fields, expected) => {
    expect(otaStateFrom(msg(fields), { phase: 'requested', targetVersion: '1.2.3', updatedAt: AT }, AT)).toMatchObject(expected);
  });

  test('reaching the target version completes an update (devices reboot instead of sending ota_complete)', () => {
    const previous = { phase: 'in_progress' as const, targetVersion: '1.2.3', updatedAt: AT };
    expect(otaStateFrom(msg({ type: 'version', version: '1.2.3' }), previous, AT)).toMatchObject({ phase: 'complete' });
    expect(otaStateFrom(msg({ type: 'version', version: '1.2.2' }), previous, AT)).toBeUndefined();
    expect(otaStateFrom(msg({ type: 'pong' }), previous, AT)).toBeUndefined();
  });
});

describe('registryUpdate', () => {
  test('records lastSeen, project for new devices, and the reported version', () => {
    expect(registryUpdate(msg({ type: 'version', version: '1.0.331' }), undefined, AT)).toEqual({
      lastSeen: AT,
      project: 'bootboots',
      currentVersion: '1.0.331',
    });
  });

  test('keeps an edited project and stores status heartbeats without topic metadata', () => {
    const update = registryUpdate(msg({ channel: 'status', receivedAt: 1, uptime_seconds: 5 }), { deviceId: 'x', project: 'other' }, AT);
    expect(update).toEqual({ lastSeen: AT, lastStatus: { uptime_seconds: 5 } });
  });
});

test('handler updates the registry and broadcasts, pruning gone connections', async () => {
  ddb.on(GetCommand).resolves({});
  ddb.on(UpdateCommand).resolves({ Attributes: { deviceId: 'BootBootsThing', lastSeen: AT } });
  ddb.on(ScanCommand).resolves({ Items: [{ connectionId: 'a' }, { connectionId: 'b' }] });
  ddb.on(DeleteCommand).resolves({});
  ws.on(PostToConnectionCommand, { ConnectionId: 'a' }).resolves({});
  ws.on(PostToConnectionCommand, { ConnectionId: 'b' }).rejects(new GoneException({ message: 'gone', $metadata: {} }));

  await handler(msg({ type: 'pong', receivedAt: Date.parse(AT) }));

  const posted = JSON.parse(new TextDecoder().decode(ws.commandCalls(PostToConnectionCommand)[0].args[0].input.Data as Uint8Array));
  expect(posted).toMatchObject({ type: 'deviceMessage', deviceId: 'BootBootsThing', channel: 'responses', device: { lastSeen: AT } });
  expect(ddb.commandCalls(DeleteCommand)[0].args[0].input.Key).toEqual({ connectionId: 'b' });
});

test('handler ignores messages without topic metadata', async () => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  await handler({} as DeviceMessage);
  expect(ddb.calls()).toHaveLength(0);
});
