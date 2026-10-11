export type HwType = 'esp32' | 'pi' | 'unknown';

export type OtaPhase =
  | 'requested'
  | 'in_progress'
  | 'awaiting_approval'
  | 'approved'
  | 'complete'
  | 'error'
  | 'rolled_back'
  | 'cancelled';

export interface OtaState {
  phase: OtaPhase;
  targetVersion?: string;
  progress?: number;
  status?: string;
  message?: string;
  updatedAt: string;
}

/** A device-registry row in DynamoDB. */
export interface RegistryEntry {
  deviceId: string;
  /** MQTT topic prefix and Thing attribute, e.g. "bootboots". */
  project?: string;
  /** Firmware bucket prefix if it differs from project, e.g. "BootBoots". */
  firmwareProject?: string;
  deviceType?: string;
  hwType?: HwType;
  capabilities?: string[];
  currentVersion?: string;
  lastSeen?: string;
  lastStatus?: Record<string, unknown>;
  otaState?: OtaState;
  notes?: string;
}

/** What the API returns: registry merged with the IoT Thing. */
export interface Device extends RegistryEntry {
  project: string;
  capabilities: string[];
  hasThing: boolean;
  registered: boolean;
}

export interface ManifestVersion {
  version: string;
  timestamp: string;
  firmware_path: string;
  size: number;
  sha256?: string;
  signed?: boolean;
}

export interface Manifest {
  project: string;
  versions: ManifestVersion[];
  internal?: boolean;
  artefactType?: 'bin' | 'tarball';
}
