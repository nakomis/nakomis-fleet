import { ThemeProvider } from '@mui/material/styles';
import { BrowserRouter } from 'react-router';
import { FleetProvider } from './FleetContext';
import { FleetRoutes } from './FleetRoutes';
import type { ShellContext } from './shell-contract';
import { theme } from './theme';

/** The Module Federation entry point (`fleet/App`), mounted by nakomis-shell at ShellContext.basePath. */
export default function ShellApp(shell: ShellContext) {
  return (
    <ThemeProvider theme={theme}>
      <FleetProvider shell={shell}>
        <BrowserRouter basename={shell.basePath}>
          <FleetRoutes />
        </BrowserRouter>
      </FleetProvider>
    </ThemeProvider>
  );
}
