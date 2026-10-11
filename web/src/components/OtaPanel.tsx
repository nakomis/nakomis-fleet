import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import LinearProgress from '@mui/material/LinearProgress';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useEffect, useState } from 'react';
import type { Device } from '../api/types';
import { useFleet } from '../FleetContext';
import { useAsync } from '../hooks/useAsync';
import { ACTIVE_PHASES, formatBytes, isStuck, OTA_LABELS, quietLimitMs } from './format';

/** Devices reboot instead of sending ota_complete, so while an update is in flight we ask for the version. */
export const VERSION_POLL_MS = 30_000;

export function OtaPanel({
  device,
  onDeviceChange,
}: {
  device: Device;
  onDeviceChange: (d: Device) => void;
}) {
  const { api } = useFleet();
  const listing = useAsync(
    () => api.listFirmware(device.project, device.deviceId),
    `${device.project}/${device.deviceId}/${device.firmwareProject ?? ''}`,
  );
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const state = device.otaState;
  const active = Boolean(state && ACTIVE_PHASES.includes(state.phase));
  const signedOnly = device.capabilities.includes('ota-signed');
  const approval = device.capabilities.includes('ota-approval');
  const versions = listing.data?.versions ?? [];

  useEffect(() => {
    if (versions.length > 0 && !versions.some((v) => v.version === selected))
      setSelected(versions[0].version);
  }, [versions, selected]);

  // Re-render every 30 s so "no word from the device" appears without another update arriving.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(timer);
  }, [active]);

  useEffect(() => {
    if (!active || state?.phase === 'awaiting_approval') return;
    const started = Date.parse(state!.updatedAt);
    const timer = setInterval(() => {
      if (Date.now() - started > quietLimitMs('in_progress') * 1.5) return;
      api.sendCommand(device.deviceId, { command: 'get_version' }).catch(() => {});
    }, VERSION_POLL_MS);
    return () => clearInterval(timer);
  }, [active, state, api, device.deviceId]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const start = () =>
    run(async () => {
      const res = await api.startOta(device.deviceId, selected);
      onDeviceChange({ ...device, otaState: res.otaState });
    });

  const cancel = () =>
    run(async () => {
      await api.cancelOta(device.deviceId);
      onDeviceChange({
        ...device,
        otaState: { ...state!, phase: 'cancelled', updatedAt: new Date().toISOString() },
      });
    });

  const chosen = versions.find((v) => v.version === selected);

  return (
    <Card>
      <CardContent>
        <Typography variant="h6" gutterBottom>
          Firmware
        </Typography>
        <Typography variant="body2" color="text.secondary" gutterBottom>
          Running {device.currentVersion || 'unknown version'}
          {listing.data && ` · ${listing.data.project} in ${listing.data.env}`}
          {signedOnly && ' · accepts signed builds only'}
          {approval && ' · installs after approval on the device'}
        </Typography>

        {listing.error && <Alert severity="error">{listing.error}</Alert>}
        {listing.data && versions.length === 0 && (
          <Alert severity="info">
            {signedOnly
              ? 'No signed builds published for this project.'
              : 'No firmware published for this project.'}
          </Alert>
        )}

        {versions.length > 0 && (
          <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap', mt: 2 }}>
            <TextField
              select
              size="small"
              label="Version"
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              disabled={active}
              sx={{ minWidth: 220 }}
            >
              {versions.map((v) => (
                <MenuItem key={v.version} value={v.version}>
                  {v.version}
                  {v.version === device.currentVersion ? ' (installed)' : ''}
                  {v.signed ? ' · signed' : ''}
                </MenuItem>
              ))}
            </TextField>
            {active ? (
              <Button variant="outlined" color="warning" onClick={cancel} disabled={busy}>
                Cancel update
              </Button>
            ) : (
              <Button variant="contained" onClick={start} disabled={busy || !selected}>
                Update to {selected}
              </Button>
            )}
          </Box>
        )}
        {chosen && (
          <Typography
            variant="caption"
            color="text.secondary"
            component="p"
            sx={{ mt: 1, wordBreak: 'break-all' }}
          >
            {formatBytes(chosen.size)} · built {new Date(chosen.timestamp).toLocaleString('en-GB')}
            {chosen.sha256 && ` · sha256 ${chosen.sha256}`}
          </Typography>
        )}

        {error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}

        {state && (
          <Box sx={{ mt: 2 }}>
            <Typography variant="subtitle2">
              {OTA_LABELS[state.phase]}
              {state.targetVersion && ` (${state.targetVersion})`}
            </Typography>
            {active && state.phase !== 'awaiting_approval' && (
              <LinearProgress
                variant={state.progress ? 'determinate' : 'indeterminate'}
                value={state.progress ?? 0}
                sx={{ my: 1 }}
              />
            )}
            {state.status && (
              <Typography variant="body2" color="text.secondary">
                {state.status}
              </Typography>
            )}
            {state.phase === 'awaiting_approval' && (
              <Alert severity="warning" sx={{ mt: 1 }}>
                The device has downloaded and verified the update and is waiting for you to approve it on the
                device itself. This can take several minutes.
              </Alert>
            )}
            {state.phase === 'rolled_back' && (
              <Alert severity="error" sx={{ mt: 1 }}>
                The device installed the update, failed its self-test and rolled back to the previous version.
              </Alert>
            )}
            {state.phase === 'error' && state.message && (
              <Alert severity="error" sx={{ mt: 1 }}>
                {state.message === 'rejected' ? 'The update was rejected on the device.' : state.message}
              </Alert>
            )}
            {isStuck(state) && (
              <Alert severity="warning" sx={{ mt: 1 }}>
                No word from the device since {new Date(state.updatedAt).toLocaleTimeString('en-GB')}. It may
                still be rebooting, or offline.
              </Alert>
            )}
          </Box>
        )}
      </CardContent>
    </Card>
  );
}
