import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Typography from '@mui/material/Typography';
import { useState } from 'react';
import type { Device } from '../api/types';
import { useFleet } from '../FleetContext';

const COMMANDS = [
  { command: 'ping', label: 'Ping' },
  { command: 'get_version', label: 'Get version' },
  { command: 'get_status', label: 'Get status' },
];

export function CommandsPanel({ device }: { device: Device }) {
  const { api } = useFleet();
  const [sent, setSent] = useState<string>();
  const [error, setError] = useState<string>();
  const [confirmReboot, setConfirmReboot] = useState(false);

  async function send(command: string) {
    setError(undefined);
    try {
      await api.sendCommand(device.deviceId, { command });
      setSent(command);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Card>
      <CardContent>
        <Typography variant="h6" gutterBottom>
          Commands
        </Typography>
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
          {COMMANDS.map(({ command, label }) => (
            <Button key={command} variant="outlined" size="small" onClick={() => void send(command)}>
              {label}
            </Button>
          ))}
          <Button variant="outlined" size="small" color="warning" onClick={() => setConfirmReboot(true)}>
            Reboot
          </Button>
        </Box>
        {sent && !error && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            Sent {sent}; replies appear in the log below.
          </Typography>
        )}
        {error && (
          <Alert severity="error" sx={{ mt: 1 }}>
            {error}
          </Alert>
        )}
      </CardContent>
      <Dialog open={confirmReboot} onClose={() => setConfirmReboot(false)}>
        <DialogTitle>Reboot {device.deviceId}?</DialogTitle>
        <DialogContent>It will be offline for a short while.</DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmReboot(false)}>Cancel</Button>
          <Button
            color="warning"
            onClick={() => {
              setConfirmReboot(false);
              void send('reboot');
            }}
          >
            Reboot
          </Button>
        </DialogActions>
      </Dialog>
    </Card>
  );
}
