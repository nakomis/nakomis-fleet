import type { APIGatewayProxyResultV2 } from 'aws-lambda';

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export function parseBody<T>(body: string | undefined, isBase64Encoded = false): T {
  if (!body) return {} as T;
  try {
    return JSON.parse(isBase64Encoded ? Buffer.from(body, 'base64').toString('utf-8') : body) as T;
  } catch {
    throw new HttpError(400, 'Body must be JSON');
  }
}

// Same rules as the firmware bucket: Thing names and project prefixes are simple identifiers.
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
export function assertId(value: string | undefined, what: string): string {
  if (!value || !ID.test(value)) throw new HttpError(400, `Invalid ${what}`);
  return value;
}

const SEMVER = /^\d+\.\d+\.\d+$/;
export function assertVersion(value: unknown): string {
  if (typeof value !== 'string' || !SEMVER.test(value)) throw new HttpError(400, 'version must be x.y.z');
  return value;
}
