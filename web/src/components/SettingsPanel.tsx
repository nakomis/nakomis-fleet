import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useState } from 'react';
import type { Device, HwType } from '../api/types';
import { useFleet } from '../FleetContext';

export function SettingsPanel({
  device,
  onDeviceChange,
}: {
  device: Device;
  onDeviceChange: (d: Device) => void;
}) {
  const { api } = useFleet();
  const [form, setForm] = useState({
    project: device.project,
    firmwareProject: device.firmwareProject ?? '',
    deviceType: device.deviceType ?? '',
    hwType: device.hwType ?? 'esp32',
    capabilities: device.capabilities.join(', '),
    notes: device.notes ?? '',
  });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ severity: 'success' | 'error'; text: string }>();
  const [wipeOpen, setWipeOpen] = useState(false);
  const [wipeProject, setWipeProject] = useState('');

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  async function save() {
    setSaving(true);
    setMessage(undefined);
    try {
      const updated = await api.updateDevice(device.deviceId, {
        project: form.project.trim(),
        firmwareProject: form.firmwareProject.trim(),
        deviceType: form.deviceType.trim() || undefined,
        hwType: form.hwType as HwType,
        capabilities: form.capabilities
          .split(',')
          .map((c) => c.trim())
          .filter(Boolean),
        notes: form.notes,
      });
      onDeviceChange(updated);
      setMessage({ severity: 'success', text: 'Saved' });
    } catch (err) {
      setMessage({ severity: 'error', text: (err as Error).message });
    } finally {
      setSaving(false);
    }
  }

  async function wipe() {
    setWipeOpen(false);
    try {
      onDeviceChange(await api.wipe(device.deviceId, wipeProject.trim()));
      setForm((f) => ({ ...f, project: wipeProject.trim(), firmwareProject: '' }));
      setMessage({
        severity: 'success',
        text: `Wipe sent; ${device.deviceId} now belongs to ${wipeProject.trim()}`,
      });
    } catch (err) {
      setMessage({ severity: 'error', text: (err as Error).message });
    }
  }

  return (
    <Card>
      <CardContent>
        <Typography variant="h6" gutterBottom>
          Settings
        </Typography>
        <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' } }}>
          <TextField
            size="small"
            label="Project (MQTT topic prefix)"
            value={form.project}
            onChange={set('project')}
          />
          <TextField
            size="small"
            label="Firmware project"
            helperText="Bucket prefix, if it differs (e.g. BootBoots)"
            value={form.firmwareProject}
            onChange={set('firmwareProject')}
          />
          <TextField size="small" label="Device type" value={form.deviceType} onChange={set('deviceType')} />
          <TextField select size="small" label="Hardware" value={form.hwType} onChange={set('hwType')}>
            <MenuItem value="esp32">ESP32</MenuItem>
            <MenuItem value="pi">Raspberry Pi</MenuItem>
            <MenuItem value="unknown">Other</MenuItem>
          </TextField>
          <TextField
            size="small"
            label="Capabilities"
            helperText="Comma-separated, e.g. ota, ota-signed, ota-approval"
            value={form.capabilities}
            onChange={set('capabilities')}
            sx={{ gridColumn: { sm: 'span 2' } }}
          />
          <TextField
            size="small"
            label="Notes"
            multiline
            minRows={2}
            value={form.notes}
            onChange={set('notes')}
            sx={{ gridColumn: { sm: 'span 2' } }}
          />
        </Box>
        <Box sx={{ display: 'flex', gap: 1, mt: 2 }}>
          <Button variant="contained" onClick={() => void save()} disabled={saving || !form.project.trim()}>
            Save
          </Button>
          <Button color="error" onClick={() => setWipeOpen(true)}>
            Wipe and re-purpose…
          </Button>
        </Box>
        {message && (
          <Alert severity={message.severity} sx={{ mt: 2 }}>
            {message.text}
          </Alert>
        )}
      </CardContent>
      <Dialog open={wipeOpen} onClose={() => setWipeOpen(false)}>
        <DialogTitle>Wipe {device.deviceId}?</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 2 }}>
            Sends <code>wipe</code> so a device that supports it resets its settings, then moves it to another
            project. Its next update comes from that project's firmware.
          </DialogContentText>
          <TextField
            autoFocus
            fullWidth
            size="small"
            label="New project"
            value={wipeProject}
            onChange={(e) => setWipeProject(e.target.value)}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setWipeOpen(false)}>Cancel</Button>
          <Button color="error" disabled={!wipeProject.trim()} onClick={() => void wipe()}>
            Wipe
          </Button>
        </DialogActions>
      </Dialog>
    </Card>
  );
}
