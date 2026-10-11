import { CopyObjectCommand, GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { HttpError } from './http';
import type { Manifest, ManifestVersion } from './types';

export const s3 = new S3Client({});

/** Device downloads get minutes, not hours (the device starts downloading straight away). */
export const PRESIGN_SECONDS = 600;

const bucket = () => {
  const name = process.env.FIRMWARE_BUCKET;
  if (!name) throw new Error('FIRMWARE_BUCKET is not set');
  return name;
};

export async function listFirmwareProjects(bucketName = bucket()): Promise<string[]> {
  const projects: string[] = [];
  let ContinuationToken: string | undefined;
  do {
    const res = await s3.send(new ListObjectsV2Command({ Bucket: bucketName, Delimiter: '/', ContinuationToken }));
    for (const p of res.CommonPrefixes ?? []) if (p.Prefix) projects.push(p.Prefix.replace(/\/$/, ''));
    ContinuationToken = res.NextContinuationToken;
  } while (ContinuationToken);
  return projects;
}

export async function getManifest(project: string, bucketName = bucket()): Promise<Manifest | undefined> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucketName, Key: `${project}/manifest.json` }));
    return JSON.parse(await res.Body!.transformToString()) as Manifest;
  } catch (err) {
    const name = (err as Error).name;
    if (name === 'NoSuchKey' || name === 'AccessDenied') return undefined;
    throw err;
  }
}

/**
 * Thing attributes use lower-case project names ("bootboots") while firmware prefixes are often
 * PascalCase ("BootBoots"). An explicit firmwareProject wins; otherwise match case-insensitively.
 */
export async function resolveFirmwareProject(project: string, firmwareProject?: string): Promise<string | undefined> {
  if (firmwareProject) return firmwareProject;
  const projects = await listFirmwareProjects();
  return projects.find((p) => p === project) ?? projects.find((p) => p.toLowerCase() === project.toLowerCase());
}

export async function findVersion(firmwareProject: string, version: string): Promise<ManifestVersion> {
  const manifest = await getManifest(firmwareProject);
  const entry = manifest?.versions.find((v) => v.version === version);
  if (!entry) throw new HttpError(404, `No ${firmwareProject} firmware ${version}`);
  return entry;
}

export async function presignFirmware(entry: ManifestVersion): Promise<string> {
  const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket(), Key: entry.firmware_path }), {
    expiresIn: PRESIGN_SECONDS,
  });
  if (!url.startsWith('https://')) throw new Error('Refusing to hand out a non-HTTPS firmware URL');
  return url;
}

/** Copies a build from the sandbox bucket into this env's bucket, keeping its metadata (sha256, signed). */
export async function promoteFromSandbox(firmwareProject: string, version: string): Promise<void> {
  const source = process.env.PROMOTE_SOURCE_BUCKET;
  if (!source) throw new HttpError(400, 'Promotion is only available in prod');
  const sourceManifest = await getManifest(firmwareProject, source);
  const entry = sourceManifest?.versions.find((v) => v.version === version);
  if (!entry) throw new HttpError(404, `No sandbox ${firmwareProject} firmware ${version}`);
  await s3.send(
    new CopyObjectCommand({
      Bucket: bucket(),
      Key: entry.firmware_path,
      CopySource: `${source}/${entry.firmware_path}`,
      MetadataDirective: 'COPY',
    }),
  );
}

export const sandboxManifest = async (firmwareProject: string) => {
  const source = process.env.PROMOTE_SOURCE_BUCKET;
  return source ? getManifest(firmwareProject, source) : undefined;
};
