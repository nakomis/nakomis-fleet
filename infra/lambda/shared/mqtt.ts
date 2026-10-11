import { DescribeEndpointCommand } from '@aws-sdk/client-iot';
import { IoTDataPlaneClient, PublishCommand } from '@aws-sdk/client-iot-data-plane';
import { iot } from './things';

let dataClient: Promise<IoTDataPlaneClient> | undefined;

function client(): Promise<IoTDataPlaneClient> {
  dataClient ??= iot
    .send(new DescribeEndpointCommand({ endpointType: 'iot:Data-ATS' }))
    .then((res) => new IoTDataPlaneClient({ endpoint: `https://${res.endpointAddress}` }));
  return dataClient;
}

export const commandTopic = (project: string, deviceId: string) => `${project}/${deviceId}/commands`;

export async function publishCommand(project: string, deviceId: string, payload: Record<string, unknown>): Promise<void> {
  const c = await client();
  await c.send(
    new PublishCommand({
      topic: commandTopic(project, deviceId),
      qos: 1,
      payload: new TextEncoder().encode(JSON.stringify(payload)),
    }),
  );
}

// Devices use PubSubClient with a 2 KB buffer that must also hold the topic, and MqttOTA accepts at most
// 10 url_chunk messages. Presigned URLs carrying a session token are ~1.3 KB, so long ones are chunked.
export const MAX_SINGLE_MESSAGE = 1500;
export const URL_CHUNK_SIZE = 400;
export const MAX_URL_CHUNKS = 10;

/**
 * sha256 is optional on the wire: the Pi agent verifies it, and ESP32 firmware ignores unknown fields.
 */
export function otaMessages(url: string, version: string, sha256?: string): Record<string, unknown>[] {
  const extra = sha256 ? { sha256 } : {};
  const single = { command: 'ota_update', url, version, ...extra };
  if (JSON.stringify(single).length <= MAX_SINGLE_MESSAGE) return [single];
  const total = Math.ceil(url.length / URL_CHUNK_SIZE);
  if (total > MAX_URL_CHUNKS) throw new Error(`Firmware URL too long to send (${url.length} chars)`);
  return Array.from({ length: total }, (_, i) => ({
    command: 'url_chunk',
    chunk_index: i,
    total_chunks: total,
    chunk_data: url.slice(i * URL_CHUNK_SIZE, (i + 1) * URL_CHUNK_SIZE),
    version,
    ...(i === total - 1 ? extra : {}),
  }));
}
