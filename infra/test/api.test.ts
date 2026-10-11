import { CopyObjectCommand, GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { DescribeEndpointCommand, DescribeThingCommand, IoTClient, ListThingsCommand, UpdateThingCommand } from '@aws-sdk/client-iot';
import { IoTDataPlaneClient, PublishCommand } from '@aws-sdk/client-iot-data-plane';
import { DynamoDBDocumentClient, GetCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { eligibleVersions, handler } from '../lambda/api/index';
import type { Device } from '../lambda/shared/types';
import { apiEvent, parse, s3Body } from './helpers';

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(async (_c: unknown, cmd: { input: { Key: string } }) => `https://bucket.s3.amazonaws.com/${cmd.input.Key}?X-Amz-Signature=sig`),
}));

const s3 = mockClient(S3Client);
const iot = mockClient(IoTClient);
const iotData = mockClient(IoTDataPlaneClient);
const ddb = mockClient(DynamoDBDocumentClient);

const MANIFEST = {
  project: 'BootBoots',
  versions: [
    { version: '1.0.331', timestamp: 't', firmware_path: 'BootBoots/1.0.331/firmware.bin', size: 10, sha256: 'aa' },
    { version: '1.0.330', timestamp: 't', firmware_path: 'BootBoots/1.0.330/firmware.bin', size: 10, sha256: 'bb', signed: true },
  ],
};

function published() {
  return iotData.commandCalls(PublishCommand).map((c) => ({
    topic: c.args[0].input.topic,
    payload: JSON.parse(new TextDecoder().decode(c.args[0].input.payload as Uint8Array)),
  }));
}

beforeEach(() => {
  for (const m of [s3, iot, iotData, ddb]) m.reset();
  process.env.DEVICES_TABLE = 'devices';
  process.env.FIRMWARE_BUCKET = 'nakomis-firmware-sandbox';
  process.env.DEPLOY_ENV = 'sandbox';
  delete process.env.PROMOTE_SOURCE_BUCKET;
  iot.on(DescribeEndpointCommand).resolves({ endpointAddress: 'abc-ats.iot.eu-west-2.amazonaws.com' });
  iot.on(DescribeThingCommand).rejects(Object.assign(new Error('nope'), { name: 'ResourceNotFoundException' }));
  iot.on(DescribeThingCommand, { thingName: 'BootBootsThing' }).resolves({
    attributes: { project: 'bootboots', deviceType: 'bootboots', capabilities: 'photos,logs' },
  });
  ddb.on(GetCommand).resolves({});
  ddb.on(UpdateCommand).resolves({ Attributes: {} });
  iotData.on(PublishCommand).resolves({});
  s3.on(ListObjectsV2Command).resolves({ CommonPrefixes: [{ Prefix: 'BootBoots/' }, { Prefix: 'NakostatBoiler/' }] });
  s3.on(GetObjectCommand, { Key: 'BootBoots/manifest.json' }).resolves({ Body: s3Body(MANIFEST) });
});

describe('GET /devices', () => {
  test('merges IoT Things with the registry', async () => {
    iot.on(ListThingsCommand).resolves({
      things: [
        { thingName: 'BootBootsThing', attributes: { project: 'bootboots', capabilities: 'photos,logs' } },
        { thingName: 'MushroomThing', attributes: {} },
      ],
    });
    ddb.on(ScanCommand).resolves({
      Items: [
        { deviceId: 'BootBootsThing', currentVersion: '1.0.330', lastSeen: '2026-10-11T17:00:00Z' },
        { deviceId: 'tinycrypt-sandbox-key-1', project: 'tinycrypt', capabilities: ['ota', 'ota-signed'] },
      ],
    });

    const { status, body } = parse(await handler(apiEvent('GET /devices')));

    expect(status).toBe(200);
    expect(body.devices).toEqual([
      expect.objectContaining({ deviceId: 'BootBootsThing', project: 'bootboots', capabilities: ['photos', 'logs'], currentVersion: '1.0.330', hasThing: true, registered: true }),
      expect.objectContaining({ deviceId: 'tinycrypt-sandbox-key-1', project: 'tinycrypt', hasThing: false, registered: true }),
      expect.objectContaining({ deviceId: 'MushroomThing', project: 'unassigned', capabilities: [], hasThing: true, registered: false }),
    ]);
  });
});

describe('POST /devices/{id}/ota', () => {
  test('presigns the build and publishes ota_update on the device command topic', async () => {
    const { status, body } = parse(
      await handler(apiEvent('POST /devices/{id}/ota', { pathParameters: { id: 'BootBootsThing' }, body: { version: '1.0.331' } })),
    );

    expect(status).toBe(202);
    expect(body).toMatchObject({ otaState: { phase: 'requested', targetVersion: '1.0.331' }, sha256: 'aa', signed: false });
    expect(published()).toEqual([
      {
        topic: 'bootboots/BootBootsThing/commands',
        payload: { command: 'ota_update', url: 'https://bucket.s3.amazonaws.com/BootBoots/1.0.331/firmware.bin?X-Amz-Signature=sig', version: '1.0.331' },
      },
    ]);
  });

  test('refuses unsigned builds for signed-only devices', async () => {
    ddb.on(GetCommand).resolves({ Item: { deviceId: 'BootBootsThing', capabilities: ['ota', 'ota-signed'] } });

    const res = parse(await handler(apiEvent('POST /devices/{id}/ota', { pathParameters: { id: 'BootBootsThing' }, body: { version: '1.0.331' } })));

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/only accepts signed firmware/);
    expect(published()).toHaveLength(0);
  });

  test('allows signed builds for signed-only devices', async () => {
    ddb.on(GetCommand).resolves({ Item: { deviceId: 'BootBootsThing', capabilities: ['ota', 'ota-signed', 'ota-approval'] } });

    const res = parse(await handler(apiEvent('POST /devices/{id}/ota', { pathParameters: { id: 'BootBootsThing' }, body: { version: '1.0.330' } })));

    expect(res.status).toBe(202);
    expect(res.body.awaitsApproval).toBe(true);
  });

  test.each([
    [{ id: 'BootBootsThing' }, { version: '9.9.9' }, 404],
    [{ id: 'BootBootsThing' }, { version: 'latest' }, 400],
    [{ id: 'NoSuchThing' }, { version: '1.0.0' }, 404],
    [{ id: 'bad/id' }, { version: '1.0.0' }, 400],
  ])('rejects %j %j with %i', async (pathParameters, body, expected) => {
    const res = parse(await handler(apiEvent('POST /devices/{id}/ota', { pathParameters, body })));
    expect(res.status).toBe(expected);
  });

  test('uses the registry firmwareProject when set', async () => {
    ddb.on(GetCommand).resolves({ Item: { deviceId: 'BootBootsThing', firmwareProject: 'NakostatBoiler' } });
    s3.on(GetObjectCommand, { Key: 'NakostatBoiler/manifest.json' }).resolves({
      Body: s3Body({ project: 'NakostatBoiler', versions: [{ version: '0.2.0', timestamp: 't', firmware_path: 'NakostatBoiler/0.2.0/firmware.bin', size: 1 }] }),
    });

    const res = parse(await handler(apiEvent('POST /devices/{id}/ota', { pathParameters: { id: 'BootBootsThing' }, body: { version: '0.2.0' } })));

    expect(res.status).toBe(202);
    expect(published()[0].payload.url).toContain('NakostatBoiler/0.2.0/firmware.bin');
  });
});

test('cancel publishes ota_cancel', async () => {
  const res = parse(await handler(apiEvent('POST /devices/{id}/ota/cancel', { pathParameters: { id: 'BootBootsThing' } })));
  expect(res.status).toBe(202);
  expect(published()).toEqual([{ topic: 'bootboots/BootBootsThing/commands', payload: { command: 'ota_cancel' } }]);
});

describe('POST /devices/{id}/command', () => {
  test('passes commands through', async () => {
    const res = parse(await handler(apiEvent('POST /devices/{id}/command', { pathParameters: { id: 'BootBootsThing' }, body: { command: 'get_version' } })));
    expect(res.status).toBe(202);
    expect(published()[0].payload).toEqual({ command: 'get_version' });
  });

  test.each(['ota_update', 'url_chunk'])('refuses %s, which must go through the OTA endpoint', async (command) => {
    const res = parse(await handler(apiEvent('POST /devices/{id}/command', { pathParameters: { id: 'BootBootsThing' }, body: { command, url: 'http://evil' } })));
    expect(res.status).toBe(400);
    expect(published()).toHaveLength(0);
  });

  test('requires a command', async () => {
    const res = parse(await handler(apiEvent('POST /devices/{id}/command', { pathParameters: { id: 'BootBootsThing' }, body: {} })));
    expect(res.status).toBe(400);
  });
});

describe('PUT /devices/{id}', () => {
  test('updates the registry and mirrors project and capabilities onto the Thing', async () => {
    iot.on(UpdateThingCommand).resolves({});

    const res = parse(
      await handler(apiEvent('PUT /devices/{id}', { pathParameters: { id: 'BootBootsThing' }, body: { project: 'bootboots', capabilities: ['ota', 'photos'], firmwareProject: 'BootBoots' } })),
    );

    expect(res.status).toBe(200);
    const update = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(Object.values(update.ExpressionAttributeValues!)).toEqual(['bootboots', 'BootBoots', ['ota', 'photos']]);
    expect(iot.commandCalls(UpdateThingCommand)[0].args[0].input).toEqual({
      thingName: 'BootBootsThing',
      attributePayload: { attributes: { project: 'bootboots', capabilities: 'ota,photos' }, merge: true },
    });
  });

  test.each([
    [{ project: 'has space' }],
    [{ hwType: 'toaster' }],
    [{ capabilities: ['a,b'] }],
    [{ notes: 'x'.repeat(2001) }],
  ])('rejects %j', async (body) => {
    const res = parse(await handler(apiEvent('PUT /devices/{id}', { pathParameters: { id: 'BootBootsThing' }, body })));
    expect(res.status).toBe(400);
  });

  test('registers devices without a Thing (e.g. Pis) without touching IoT', async () => {
    ddb.on(UpdateCommand).resolves({ Attributes: { deviceId: 'pi-1', project: 'pish', hwType: 'pi' } });
    const res = parse(await handler(apiEvent('PUT /devices/{id}', { pathParameters: { id: 'pi-1' }, body: { project: 'pish', hwType: 'pi' } })));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ deviceId: 'pi-1', project: 'pish', hwType: 'pi', hasThing: false });
    expect(iot.commandCalls(UpdateThingCommand)).toHaveLength(0);
  });
});

test('wipe sends wipe on the old topic and moves the device', async () => {
  iot.on(UpdateThingCommand).resolves({});

  const res = parse(await handler(apiEvent('POST /devices/{id}/wipe', { pathParameters: { id: 'BootBootsThing' }, body: { project: 'kappawarmer' } })));

  expect(res.status).toBe(202);
  expect(published()).toEqual([{ topic: 'bootboots/BootBootsThing/commands', payload: { command: 'wipe', project: 'kappawarmer' } }]);
  expect(iot.commandCalls(UpdateThingCommand)[0].args[0].input.attributePayload?.attributes).toEqual({ project: 'kappawarmer' });
});

describe('firmware', () => {
  test('GET /projects lists non-internal projects with their latest version', async () => {
    s3.on(GetObjectCommand, { Key: 'NakostatBoiler/manifest.json' }).resolves({ Body: s3Body({ project: 'NakostatBoiler', versions: [], internal: true }) });

    const res = parse(await handler(apiEvent('GET /projects')));

    expect(res.body).toEqual({ env: 'sandbox', projects: [{ name: 'BootBoots', latest: '1.0.331', versions: 2, artefactType: 'bin' }] });
  });

  test('GET /projects/{project}/firmware filters for the device and resolves case', async () => {
    ddb.on(GetCommand).resolves({ Item: { deviceId: 'BootBootsThing', capabilities: ['ota-signed'] } });

    const res = parse(await handler(apiEvent('GET /projects/{project}/firmware', { pathParameters: { project: 'bootboots' }, query: { deviceId: 'BootBootsThing' } })));

    expect(res.body.project).toBe('BootBoots');
    expect(res.body.versions.map((v: { version: string }) => v.version)).toEqual(['1.0.330']);
    expect(res.body.promotable).toEqual([]);
  });

  test('GET /projects/{project}/firmware/{version}/url returns a short-lived HTTPS URL', async () => {
    const res = parse(await handler(apiEvent('GET /projects/{project}/firmware/{version}/url', { pathParameters: { project: 'BootBoots', version: '1.0.331' } })));
    expect(res.body).toMatchObject({ expiresIn: 600, sha256: 'aa', signed: false });
    expect(res.body.url).toMatch(/^https:\/\//);
  });

  test('promotion is prod-only', async () => {
    const res = parse(await handler(apiEvent('POST /projects/{project}/firmware/{version}/promote', { pathParameters: { project: 'BootBoots', version: '1.0.331' } })));
    expect(res.status).toBe(400);
  });

  test('promotion copies from the sandbox bucket and lists unpromoted builds', async () => {
    process.env.PROMOTE_SOURCE_BUCKET = 'nakomis-firmware-sandbox';
    process.env.FIRMWARE_BUCKET = 'nakomis-firmware-prod';
    s3.on(CopyObjectCommand).resolves({});
    s3.on(GetObjectCommand, { Bucket: 'nakomis-firmware-prod', Key: 'BootBoots/manifest.json' }).resolves({
      Body: s3Body({ project: 'BootBoots', versions: [MANIFEST.versions[1]] }),
    });

    const list = parse(await handler(apiEvent('GET /projects/{project}/firmware', { pathParameters: { project: 'BootBoots' } })));
    expect(list.body.promotable.map((v: { version: string }) => v.version)).toEqual(['1.0.331']);

    const res = parse(await handler(apiEvent('POST /projects/{project}/firmware/{version}/promote', { pathParameters: { project: 'BootBoots', version: '1.0.331' } })));
    expect(res.status).toBe(202);
    expect(s3.commandCalls(CopyObjectCommand)[0].args[0].input).toEqual({
      Bucket: 'nakomis-firmware-prod',
      Key: 'BootBoots/1.0.331/firmware.bin',
      CopySource: 'nakomis-firmware-sandbox/BootBoots/1.0.331/firmware.bin',
      MetadataDirective: 'COPY',
    });
  });
});

test('unknown routes 404 and unexpected errors 500', async () => {
  expect(parse(await handler(apiEvent('DELETE /devices'))).status).toBe(404);
  iot.on(ListThingsCommand).rejects(new Error('boom'));
  jest.spyOn(console, 'error').mockImplementation(() => {});
  expect(parse(await handler(apiEvent('GET /devices'))).status).toBe(500);
});

test('eligibleVersions copes with a missing manifest', () => {
  expect(eligibleVersions({ capabilities: [] } as unknown as Device, undefined)).toEqual([]);
});
