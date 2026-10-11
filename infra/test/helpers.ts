import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { Readable } from 'stream';

export function apiEvent(
  routeKey: string,
  opts: { pathParameters?: Record<string, string>; body?: unknown; query?: Record<string, string> } = {},
): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    routeKey,
    pathParameters: opts.pathParameters,
    queryStringParameters: opts.query,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

export function s3Body(value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const stream = Readable.from([Buffer.from(text)]) as Readable & { transformToString: () => Promise<string> };
  stream.transformToString = async () => text;
  return stream as never;
}

export const parse = (res: unknown) => {
  const r = res as { statusCode: number; body: string };
  return { status: r.statusCode, body: JSON.parse(r.body) };
};
