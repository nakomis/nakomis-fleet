import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import LinearProgress from '@mui/material/LinearProgress';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import type { ManifestVersion } from '../api/types';
import { formatBytes } from '../components/format';
import { useFleet } from '../FleetContext';
import { useAsync } from '../hooks/useAsync';

function VersionTable({
  versions,
  action,
}: {
  versions: ManifestVersion[];
  action?: (v: ManifestVersion) => React.ReactNode;
}) {
  return (
    <TableContainer>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>Version</TableCell>
            <TableCell>Built</TableCell>
            <TableCell>Size</TableCell>
            <TableCell>SHA-256</TableCell>
            {action && <TableCell />}
          </TableRow>
        </TableHead>
        <TableBody>
          {versions.map((v) => (
            <TableRow key={v.version}>
              <TableCell>
                {v.version}{' '}
                {v.signed && <Chip size="small" label="signed" color="success" variant="outlined" />}
              </TableCell>
              <TableCell>{new Date(v.timestamp).toLocaleString('en-GB')}</TableCell>
              <TableCell>{formatBytes(v.size)}</TableCell>
              <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }} title={v.sha256}>
                {v.sha256 ? `${v.sha256.slice(0, 12)}…` : '—'}
              </TableCell>
              {action && <TableCell>{action(v)}</TableCell>}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

function ProjectFirmware({ project }: { project: string }) {
  const { api } = useFleet();
  const listing = useAsync(() => api.listFirmware(project), project);
  const [message, setMessage] = useState<{ severity: 'success' | 'error'; text: string }>();

  async function promote(version: string) {
    setMessage(undefined);
    try {
      await api.promote(project, version);
      setMessage({
        severity: 'success',
        text: `Promoted ${version}; the prod manifest updates in a few seconds.`,
      });
      setTimeout(() => void listing.reload(), 4000);
    } catch (err) {
      setMessage({ severity: 'error', text: (err as Error).message });
    }
  }

  return (
    <Box sx={{ flexGrow: 1, minWidth: 0 }}>
      <Typography variant="h6" gutterBottom>
        {listing.data?.project ?? project} <Chip size="small" label={listing.data?.env ?? '…'} />
      </Typography>
      {listing.loading && <LinearProgress />}
      {listing.error && <Alert severity="error">{listing.error}</Alert>}
      {message && (
        <Alert severity={message.severity} sx={{ mb: 2 }}>
          {message.text}
        </Alert>
      )}
      {listing.data && <VersionTable versions={listing.data.versions} />}
      {listing.data && listing.data.promotable.length > 0 && (
        <>
          <Typography variant="subtitle1" sx={{ mt: 3 }}>
            In sandbox, not yet in prod
          </Typography>
          <VersionTable
            versions={listing.data.promotable}
            action={(v) => (
              <Button size="small" variant="outlined" onClick={() => void promote(v.version)}>
                Promote
              </Button>
            )}
          />
        </>
      )}
    </Box>
  );
}

export function FirmwarePage() {
  const { project } = useParams();
  const { api } = useFleet();
  const projects = useAsync(() => api.listProjects(), 'projects');

  return (
    <Box sx={{ display: 'flex', gap: 3, flexDirection: { xs: 'column', md: 'row' } }}>
      <Box sx={{ minWidth: 220 }}>
        <Typography variant="h5" gutterBottom>
          Firmware
        </Typography>
        {projects.loading && <LinearProgress />}
        {projects.error && <Alert severity="error">{projects.error}</Alert>}
        <List dense>
          {projects.data?.projects.map((p) => (
            <ListItemButton
              key={p.name}
              component={Link}
              to={`/firmware/${encodeURIComponent(p.name)}`}
              selected={p.name === project}
            >
              <ListItemText primary={p.name} secondary={p.latest ? `latest ${p.latest}` : 'no builds'} />
            </ListItemButton>
          ))}
        </List>
      </Box>
      {project ? (
        <ProjectFirmware key={project} project={project} />
      ) : (
        <Typography color="text.secondary" sx={{ mt: 6 }}>
          Choose a project to see its builds.
        </Typography>
      )}
    </Box>
  );
}
