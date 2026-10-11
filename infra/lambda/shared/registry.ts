import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { RegistryEntry } from './types';

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const table = () => {
  const name = process.env.DEVICES_TABLE;
  if (!name) throw new Error('DEVICES_TABLE is not set');
  return name;
};

export async function getEntry(deviceId: string): Promise<RegistryEntry | undefined> {
  const res = await ddb.send(new GetCommand({ TableName: table(), Key: { deviceId } }));
  return res.Item as RegistryEntry | undefined;
}

export async function scanEntries(): Promise<RegistryEntry[]> {
  const items: RegistryEntry[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new ScanCommand({ TableName: table(), ExclusiveStartKey }));
    items.push(...((res.Items ?? []) as RegistryEntry[]));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

export async function putEntry(entry: RegistryEntry): Promise<void> {
  await ddb.send(new PutCommand({ TableName: table(), Item: entry }));
}

/** Sets the given attributes (undefined values are skipped), creating the row if needed. */
export async function updateEntry(deviceId: string, fields: Partial<Omit<RegistryEntry, 'deviceId'>>): Promise<RegistryEntry> {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return (await getEntry(deviceId)) ?? { deviceId };
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const sets = entries.map(([k, v], i) => {
    names[`#f${i}`] = k;
    values[`:v${i}`] = v;
    return `#f${i} = :v${i}`;
  });
  const res = await ddb.send(
    new UpdateCommand({
      TableName: table(),
      Key: { deviceId },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    }),
  );
  return res.Attributes as RegistryEntry;
}
