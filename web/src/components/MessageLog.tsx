import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';

export interface LoggedMessage {
  id: number;
  at: string;
  channel: string;
  message: Record<string, unknown>;
}

export const MAX_LOG = 50;

export function MessageLog({ messages }: { messages: LoggedMessage[] }) {
  return (
    <Card>
      <CardContent>
        <Typography variant="h6" gutterBottom>
          Live messages
        </Typography>
        {messages.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            Nothing yet. Messages the device publishes while this page is open appear here.
          </Typography>
        ) : (
          <Box
            component="ol"
            sx={{
              m: 0,
              p: 0,
              listStyle: 'none',
              fontFamily: 'monospace',
              fontSize: 12,
              maxHeight: 320,
              overflow: 'auto',
            }}
          >
            {messages.map((m) => {
              const { project: _p, deviceId: _d, channel: _c, receivedAt: _r, ...rest } = m.message;
              return (
                <Box
                  component="li"
                  key={m.id}
                  sx={{ py: 0.5, borderBottom: 1, borderColor: 'divider', wordBreak: 'break-all' }}
                >
                  <Box component="span" sx={{ color: 'text.secondary' }}>
                    {new Date(m.at).toLocaleTimeString('en-GB')} {m.channel}{' '}
                  </Box>
                  {JSON.stringify(rest)}
                </Box>
              );
            })}
          </Box>
        )}
      </CardContent>
    </Card>
  );
}
