import Refresh from '@mui/icons-material/Refresh';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import LinearProgress from '@mui/material/LinearProgress';
import MenuItem from '@mui/material/MenuItem';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { useCallback, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { Device, DeviceMessageEvent } from '../api/types';
import { isOnline, relativeTime } from '../components/format';
import { OtaChip } from '../components/OtaChip';
import { useDeviceMessages, useFleet } from '../FleetContext';
import { useAsync } from '../hooks/useAsync';

export function mergeLive(devices: Device[], event: DeviceMessageEvent): Device[] {
  const index = devices.findIndex((d) => d.deviceId === event.deviceId);
  if (index === -1) {
    const added: Device = {
      ...event.device,
      deviceId: event.deviceId,
      project: event.device.project ?? event.project,
      capabilities: event.device.capabilities ?? [],
      hasThing: false,
      registered: true,
    };
    return [...devices, added];
  }
  const next = [...devices];
  next[index] = {
    ...next[index],
    ...event.device,
    project: next[index].project,
    capabilities: next[index].capabilities,
  };
  return next;
}

export function DevicesPage() {
  const { api } = useFleet();
  const [params, setParams] = useSearchParams();
  const project = params.get('project') ?? '';
  const { data: devices, setData, error, loading, reload } = useAsync(() => api.listDevices(), 'devices');
  const [, setTick] = useState(0);

  useDeviceMessages(
    useCallback(
      (event: DeviceMessageEvent) => {
        setData((current) => (current ? mergeLive(current, event) : current));
        setTick((t) => t + 1);
      },
      [setData],
    ),
  );

  const projects = useMemo(() => [...new Set((devices ?? []).map((d) => d.project))].sort(), [devices]);
  const shown = (devices ?? []).filter((d) => !project || d.project === project);

  return (
    <Box>
      <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', mb: 2 }}>
        <Typography variant="h5" sx={{ flexGrow: 1 }}>
          Devices
        </Typography>
        <TextField
          select
          size="small"
          label="Project"
          value={project}
          onChange={(e) => setParams(e.target.value ? { project: e.target.value } : {})}
          sx={{ minWidth: 160 }}
        >
          <MenuItem value="">All projects</MenuItem>
          {projects.map((p) => (
            <MenuItem key={p} value={p}>
              {p}
            </MenuItem>
          ))}
        </TextField>
        <Tooltip title="Refresh">
          <IconButton onClick={() => void reload()} aria-label="Refresh devices">
            <Refresh />
          </IconButton>
        </Tooltip>
      </Box>
      {loading && <LinearProgress sx={{ mb: 1 }} />}
      {error && <Alert severity="error">Could not load devices: {error}</Alert>}
      {devices && shown.length === 0 && <Alert severity="info">No devices yet.</Alert>}
      {shown.length > 0 && (
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Device</TableCell>
                <TableCell>Project</TableCell>
                <TableCell>Type</TableCell>
                <TableCell>Firmware</TableCell>
                <TableCell>Last seen</TableCell>
                <TableCell>Update</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {shown.map((d) => (
                <TableRow key={d.deviceId} hover>
                  <TableCell>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <Box
                        component="span"
                        aria-label={isOnline(d.lastSeen, undefined, d.project) ? 'online' : 'offline'}
                        sx={{
                          width: 8,
                          height: 8,
                          borderRadius: '50%',
                          bgcolor: isOnline(d.lastSeen, undefined, d.project)
                            ? 'success.main'
                            : 'text.disabled',
                          flexShrink: 0,
                        }}
                      />
                      <Link to={`/devices/${encodeURIComponent(d.deviceId)}`} style={{ color: 'inherit' }}>
                        {d.deviceId}
                      </Link>
                      {d.capabilities.includes('ota-signed') && <Chip size="small" label="signed only" />}
                    </Box>
                  </TableCell>
                  <TableCell>{d.project}</TableCell>
                  <TableCell>{d.deviceType ?? d.hwType ?? '—'}</TableCell>
                  <TableCell>{d.currentVersion || '—'}</TableCell>
                  <TableCell>{relativeTime(d.lastSeen)}</TableCell>
                  <TableCell>
                    <OtaChip state={d.otaState} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Box>
  );
}
