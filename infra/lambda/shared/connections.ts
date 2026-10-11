import { ApiGatewayManagementApiClient, GoneException, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { DeleteCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './registry';

const table = () => {
  const name = process.env.CONNECTIONS_TABLE;
  if (!name) throw new Error('CONNECTIONS_TABLE is not set');
  return name;
};

const CONNECTION_TTL_SECONDS = 2 * 60 * 60; // API Gateway closes WebSockets after 2 h anyway.

export async function addConnection(connectionId: string, sub: string): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: table(),
      Item: { connectionId, sub, ttl: Math.floor(Date.now() / 1000) + CONNECTION_TTL_SECONDS },
    }),
  );
}

export async function removeConnection(connectionId: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: table(), Key: { connectionId } }));
}

async function connectionIds(): Promise<string[]> {
  const ids: string[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new ScanCommand({ TableName: table(), ProjectionExpression: 'connectionId', ExclusiveStartKey }));
    for (const item of res.Items ?? []) ids.push(item.connectionId as string);
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return ids;
}

let management: ApiGatewayManagementApiClient | undefined;

/** Sends to every open Fleet UI. Stale connections are pruned. */
export async function broadcast(message: unknown): Promise<void> {
  const endpoint = process.env.WS_MANAGEMENT_ENDPOINT;
  if (!endpoint) throw new Error('WS_MANAGEMENT_ENDPOINT is not set');
  management ??= new ApiGatewayManagementApiClient({ endpoint });
  const data = new TextEncoder().encode(JSON.stringify(message));
  const ids = await connectionIds();
  await Promise.all(
    ids.map(async (ConnectionId) => {
      try {
        await management!.send(new PostToConnectionCommand({ ConnectionId, Data: data }));
      } catch (err) {
        if (err instanceof GoneException || (err as Error).name === 'GoneException') await removeConnection(ConnectionId);
        else console.warn(`Failed to post to ${ConnectionId}`, err);
      }
    }),
  );
}
