import type { APIGatewayProxyResultV2, APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { addConnection, removeConnection } from '../shared/connections';

type ConnectEvent = APIGatewayProxyWebsocketEventV2 & { queryStringParameters?: Record<string, string> };

let verifier: ReturnType<typeof CognitoJwtVerifier.create<{ userPoolId: string; clientId: string; tokenUse: 'access' }>> | undefined;

const getVerifier = () => {
  verifier ??= CognitoJwtVerifier.create({
    userPoolId: process.env.USER_POOL_ID!,
    clientId: process.env.CLIENT_ID!,
    tokenUse: 'access',
  });
  return verifier;
};

/** $connect: the browser can't set headers on a WebSocket, so the access token comes in ?token=. */
export const connect = async (event: ConnectEvent): Promise<APIGatewayProxyResultV2> => {
  const token = event.queryStringParameters?.token;
  if (!token) return { statusCode: 401, body: 'Missing token' };
  try {
    const payload = await getVerifier().verify(token);
    await addConnection(event.requestContext.connectionId, payload.sub);
    return { statusCode: 200, body: 'Connected' };
  } catch (err) {
    console.warn('Rejected WebSocket connection', (err as Error).message);
    return { statusCode: 401, body: 'Unauthorised' };
  }
};

export const disconnect = async (event: APIGatewayProxyWebsocketEventV2): Promise<APIGatewayProxyResultV2> => {
  await removeConnection(event.requestContext.connectionId);
  return { statusCode: 200, body: 'Disconnected' };
};

/** $default: the UI sends {"action":"ping"} to keep the connection alive; nothing else is accepted. */
export const message = async (): Promise<APIGatewayProxyResultV2> => ({ statusCode: 200, body: 'pong' });
