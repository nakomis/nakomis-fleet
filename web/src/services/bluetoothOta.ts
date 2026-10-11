// Web Bluetooth OTA, ported from sandboxsite's bluetoothService. Uses the shared esp32-bootstrap
// BluetoothOTA service; the device downloads the firmware itself from the (presigned) URL.

export const DEVICE_SERVICE_UUID = 'bb00b007-5af3-41c3-9689-2fc7175c1ba8';
export const OTA_SERVICE_UUID = '99db6ea6-27e4-434d-aafd-795cf95feb06';
export const OTA_COMMAND_CHAR_UUID = '1ac886a6-5fff-41ea-9b11-25a7dcb93a7e';
export const OTA_STATUS_CHAR_UUID = '5f5979f3-f1a6-4ce7-8360-e249c2e9333d';

export interface BleOtaResponse {
  status: 'success' | 'error' | 'progress';
  message: string;
  progress?: number;
  version?: string;
}

const MAX_SINGLE_PACKET = 512;
const CHUNK_SIZE = 400;
const CHUNK_DELAY_MS = 50;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function bleOtaPackets(url: string, version: string): Uint8Array[] {
  const single = encoder.encode(JSON.stringify({ action: 'ota_update', firmware_url: url, version }));
  if (single.length <= MAX_SINGLE_PACKET) return [single];
  const total = Math.ceil(url.length / CHUNK_SIZE);
  return Array.from({ length: total }, (_, i) =>
    encoder.encode(
      JSON.stringify({
        action: 'url_chunk',
        chunk_index: i,
        total_chunks: total,
        chunk_data: url.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE),
        version,
      }),
    ),
  );
}

export const bluetoothAvailable = () => typeof navigator !== 'undefined' && 'bluetooth' in navigator;

export class BluetoothOta {
  private device?: BluetoothDevice;
  private command?: BluetoothRemoteGATTCharacteristic;
  private status?: BluetoothRemoteGATTCharacteristic;
  version = 'unknown';

  get name() {
    return this.device?.name ?? 'device';
  }

  get connected() {
    return Boolean(this.device?.gatt?.connected);
  }

  async connect(onDisconnect: () => void): Promise<void> {
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [DEVICE_SERVICE_UUID] }, { services: [OTA_SERVICE_UUID] }],
      optionalServices: [OTA_SERVICE_UUID],
    });
    if (!this.device.gatt) throw new Error('GATT not available');
    const server = await this.device.gatt.connect();
    const service = await server.getPrimaryService(OTA_SERVICE_UUID);
    this.command = await service.getCharacteristic(OTA_COMMAND_CHAR_UUID);
    this.status = await service.getCharacteristic(OTA_STATUS_CHAR_UUID);
    this.device.addEventListener('gattserverdisconnected', onDisconnect);
    try {
      const value = await this.status.readValue();
      this.version = (JSON.parse(decoder.decode(value)) as BleOtaResponse).version ?? 'unknown';
    } catch {
      this.version = 'unknown';
    }
  }

  async monitor(callback: (response: BleOtaResponse) => void): Promise<void> {
    if (!this.status) throw new Error('Not connected');
    await this.status.startNotifications();
    this.status.addEventListener('characteristicvaluechanged', (event) => {
      const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
      if (!value) return;
      try {
        callback(JSON.parse(decoder.decode(value)) as BleOtaResponse);
      } catch {
        // partial or non-JSON notification
      }
    });
  }

  async startUpdate(url: string, version: string): Promise<void> {
    if (!this.command) throw new Error('Not connected');
    for (const packet of bleOtaPackets(url, version)) {
      await this.command.writeValue(packet as BufferSource);
      await new Promise((r) => setTimeout(r, CHUNK_DELAY_MS));
    }
  }

  async cancel(): Promise<void> {
    await this.command?.writeValue(
      encoder.encode(JSON.stringify({ action: 'cancel_update' })) as BufferSource,
    );
  }

  disconnect() {
    this.device?.gatt?.disconnect();
  }
}
