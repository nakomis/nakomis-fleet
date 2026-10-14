import ArrowBack from '@mui/icons-material/ArrowBack';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import LinearProgress from '@mui/material/LinearProgress';
import Typography from '@mui/material/Typography';
import { useCallback, useState } from 'react';
import { Link, useParams } from 'react-router';
import type { Device, DeviceMessageEvent } from '../api/types';
import { BluetoothPanel } from '../components/BluetoothPanel';
import { CommandsPanel } from '../components/CommandsPanel';
import { isOnline, relativeTime } from '../components/format';
import { type LoggedMessage, MAX_LOG, MessageLog } from '../components/MessageLog';
import { OtaChip } from '../components/OtaChip';
import { OtaPanel } from '../components/OtaPanel';
import { SettingsPanel } from '../components/SettingsPanel';
import { useDeviceMessages, useFleet } from '../FleetContext';
import { useAsync } from '../hooks/useAsync';

export function DevicePage() {
  const { id = '' } = useParams();
  const { api } = useFleet();
  const { data: device, setData, error, loading } = useAsync(() => api.getDevice(id), id);
  const [log, setLog] = useState<LoggedMessage[]>([]);

  useDeviceMessages(
    useCallback(
      (event: DeviceMessageEvent) => {
        setData((d) => (d ? { ...d, ...event.device, project: d.project, capabilities: d.capabilities } : d));
        setLog((l) =>
          [
            {
              id: (l[0]?.id ?? 0) + 1,
              at: new Date().toISOString(),
              channel: event.channel,
              message: event.message,
            },
            ...l,
          ].slice(0, MAX_LOG),
        );
      },
      [setData],
    ),
    id,
  );

  // An API response can arrive after a newer live update from the device; keep whichever OTA state is newer.
  const onDeviceChange = useCallback(
    (d: Device) =>
      setData((current) => {
        const mine = current?.otaState?.updatedAt;
        const theirs = d.otaState?.updatedAt;
        return mine && theirs && Date.parse(mine) > Date.parse(theirs)
          ? { ...d, otaState: current.otaState }
          : d;
      }),
    [setData],
  );

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2, flexWrap: 'wrap' }}>
        <IconButton component={Link} to="/" aria-label="Back to devices">
          <ArrowBack />
        </IconButton>
        <Typography variant="h5" sx={{ wordBreak: 'break-all' }}>
          {id}
        </Typography>
        {device && (
          <>
            <Chip
              size="small"
              color={isOnline(device.lastSeen, undefined, device.project) ? 'success' : 'default'}
              label={
                isOnline(device.lastSeen, undefined, device.project)
                  ? 'online'
                  : `last seen ${relativeTime(device.lastSeen)}`
              }
            />
            <Chip size="small" variant="outlined" label={device.project} />
            <OtaChip state={device.otaState} />
          </>
        )}
      </Box>
      {loading && <LinearProgress />}
      {error && <Alert severity="error">{error}</Alert>}
      {device && (
        <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr' } }}>
          <OtaPanel device={device} onDeviceChange={onDeviceChange} />
          <CommandsPanel device={device} />
          <MessageLog messages={log} />
          <SettingsPanel key={device.deviceId} device={device} onDeviceChange={onDeviceChange} />
          {device.hwType !== 'pi' && (
            <BluetoothPanel device={device} version={device.otaState?.targetVersion} />
          )}
        </Box>
      )}
    </Box>
  );
}
