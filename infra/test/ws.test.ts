import { DeleteCommand, DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

const verify = jest.fn();
jest.mock('aws-jwt-verify', () => ({ CognitoJwtVerifier: { create: () => ({ verify }) } }));

import { connect, disconnect, message } from '../lambda/ws/index';

const ddb = mockClient(DynamoDBDocumentClient);
const event = (query?: Record<string, string>) =>
  ({ requestContext: { connectionId: 'c1' }, queryStringParameters: query }) as never;

beforeEach(() => {
  ddb.reset();
  verify.mockReset();
  process.env.CONNECTIONS_TABLE = 'connections';
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

test('connect stores the connection for a valid access token', async () => {
  verify.mockResolvedValue({ sub: 'user-1' });
  ddb.on(PutCommand).resolves({});

  expect(await connect(event({ token: 'good' }))).toMatchObject({ statusCode: 200 });
  expect(ddb.commandCalls(PutCommand)[0].args[0].input.Item).toMatchObject({ connectionId: 'c1', sub: 'user-1' });
});

test('connect rejects missing and invalid tokens', async () => {
  verify.mockRejectedValue(new Error('expired'));
  expect(await connect(event())).toMatchObject({ statusCode: 401 });
  expect(await connect(event({ token: 'bad' }))).toMatchObject({ statusCode: 401 });
  expect(ddb.commandCalls(PutCommand)).toHaveLength(0);
});

test('disconnect removes the connection; messages are acknowledged', async () => {
  ddb.on(DeleteCommand).resolves({});
  expect(await disconnect(event())).toMatchObject({ statusCode: 200 });
  expect(ddb.commandCalls(DeleteCommand)).toHaveLength(1);
  expect(await message()).toMatchObject({ statusCode: 200 });
});
