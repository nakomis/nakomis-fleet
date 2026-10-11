import { DescribeThingCommand, IoTClient, ListThingsCommand, UpdateThingCommand } from '@aws-sdk/client-iot';

export const iot = new IoTClient({});

export interface ThingSummary {
  thingName: string;
  attributes: Record<string, string>;
}

export async function listThings(): Promise<ThingSummary[]> {
  const things: ThingSummary[] = [];
  let nextToken: string | undefined;
  do {
    const res = await iot.send(new ListThingsCommand({ maxResults: 250, nextToken }));
    for (const t of res.things ?? []) {
      if (t.thingName) things.push({ thingName: t.thingName, attributes: t.attributes ?? {} });
    }
    nextToken = res.nextToken;
  } while (nextToken);
  return things;
}

export async function describeThing(thingName: string): Promise<ThingSummary | undefined> {
  try {
    const res = await iot.send(new DescribeThingCommand({ thingName }));
    return { thingName, attributes: res.attributes ?? {} };
  } catch (err) {
    if ((err as Error).name === 'ResourceNotFoundException') return undefined;
    throw err;
  }
}

/** Merges attributes onto the Thing (others are kept). */
export async function setThingAttributes(thingName: string, attributes: Record<string, string>): Promise<void> {
  await iot.send(new UpdateThingCommand({ thingName, attributePayload: { attributes, merge: true } }));
}

export const parseCapabilities = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
