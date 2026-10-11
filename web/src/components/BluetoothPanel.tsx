import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import LinearProgress from '@mui/material/LinearProgress';
import Typography from '@mui/material/Typography';
import { useRef, useState } from 'react';
import type { Device } from '../api/types';
import { useFleet } from '../FleetContext';
import { BluetoothOta, bluetoothAvailable } from '../services/bluetoothOta';

/** Update a device that's in Bluetooth range, e.g. one that can't reach MQTT. */
export function BluetoothPanel({ device, version }: { device: Device; version?: string }) {
  const { api } = useFleet();
  const ble = useRef(new BluetoothOta());
  const [connected, setConnected] = useState(false);
  const [progress, setProgress] = useState<number>();
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();

  if (!bluetoothAvailable()) return null;

  async function connect() {
    setError(undefined);
    try {
      await ble.current.connect(() => setConnected(false));
      await ble.current.monitor((r) => {
        setStatus(r.message);
        if (r.progress !== undefined) setProgress(r.progress);
        if (r.status === 'error') setError(r.message);
      });
      setConnected(true);
      setStatus(`Connected to ${ble.current.name}, running ${ble.current.version}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function update() {
    if (!version) return;
    setError(undefined);
    try {
      const project = device.firmwareProject || device.project;
      const { url } = await api.firmwareUrl(project, version);
      await ble.current.startUpdate(url, version);
      setStatus('Update sent over Bluetooth; waiting for the device…');
      setProgress(0);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Card>
      <CardContent>
        <Typography variant="h6" gutterBottom>
          Bluetooth
        </Typography>
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
          {connected ? (
            <>
              <Button variant="contained" onClick={() => void update()} disabled={!version}>
                Update to {version ?? '…'} over Bluetooth
              </Button>
              <Button onClick={() => void ble.current.cancel()}>Cancel</Button>
              <Button onClick={() => ble.current.disconnect()}>Disconnect</Button>
            </>
          ) : (
            <Button variant="outlined" onClick={() => void connect()}>
              Connect over Bluetooth
            </Button>
          )}
        </Box>
        {progress !== undefined && <LinearProgress variant="determinate" value={progress} sx={{ mt: 2 }} />}
        {status && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            {status}
          </Typography>
        )}
        {error && (
          <Alert severity="error" sx={{ mt: 1 }}>
            {error}
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
