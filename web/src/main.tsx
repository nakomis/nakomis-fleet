// Standalone dev harness: `pnpm dev`, then sign in at app.sandbox.nakomis.com, copy an access token from
// session storage into localStorage['fleet.devToken'] here, and reload. Production loads ShellApp via the shell.
import { createRoot } from 'react-dom/client';
import ShellApp from './ShellApp';
import { CONTRACT_VERSION } from './shell-contract';

const token = () => localStorage.getItem('fleet.devToken') ?? '';

createRoot(document.getElementById('root') as HTMLElement).render(
  <ShellApp
    contractVersion={CONTRACT_VERSION}
    env="sandbox"
    basePath="/"
    region="eu-west-2"
    userPoolId=""
    user={{ sub: 'dev', username: 'dev' }}
    getAccessToken={async () => token()}
    getIdToken={async () => token()}
    getAwsCredentials={async () => {
      throw new Error('Not available in the dev harness');
    }}
    signOut={() => localStorage.removeItem('fleet.devToken')}
  />,
);
