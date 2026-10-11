import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import { Link, Route, Routes, useLocation } from 'react-router';
import { useLiveStatus } from './FleetContext';
import { DevicePage } from './pages/DevicePage';
import { DevicesPage } from './pages/DevicesPage';
import { FirmwarePage } from './pages/FirmwarePage';

const LIVE_LABEL = { live: 'Live', connecting: 'Connecting…', offline: 'Offline' } as const;
const LIVE_COLOUR = { live: 'success', connecting: 'default', offline: 'warning' } as const;

export function FleetRoutes() {
  const { pathname } = useLocation();
  const live = useLiveStatus();
  const tab = pathname.startsWith('/firmware') ? '/firmware' : '/';

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', borderBottom: 1, borderColor: 'divider', mb: 2 }}>
        <Tabs value={tab} sx={{ flexGrow: 1 }}>
          <Tab label="Devices" value="/" component={Link} to="/" />
          <Tab label="Firmware" value="/firmware" component={Link} to="/firmware" />
        </Tabs>
        <Chip size="small" label={LIVE_LABEL[live]} color={LIVE_COLOUR[live]} variant="outlined" />
      </Box>
      <Routes>
        <Route path="/" element={<DevicesPage />} />
        <Route path="/devices/:id" element={<DevicePage />} />
        <Route path="/firmware" element={<FirmwarePage />} />
        <Route path="/firmware/:project" element={<FirmwarePage />} />
        <Route path="*" element={<DevicesPage />} />
      </Routes>
    </Box>
  );
}
