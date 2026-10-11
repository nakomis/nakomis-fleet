import { createTheme } from '@mui/material/styles';

// Same One Dark palette as the shell; Fleet bundles its own MUI, so it applies the theme itself.
export const theme = createTheme({
  palette: {
    mode: 'dark',
    primary: { main: '#61afef' },
    secondary: { main: '#98c379' },
    error: { main: '#e06c75' },
    warning: { main: '#e5c07b' },
    success: { main: '#98c379' },
    background: { default: '#282c34', paper: '#21252b' },
    text: { primary: '#dcdfe4', secondary: '#abb2bf' },
  },
  shape: { borderRadius: 8 },
});
