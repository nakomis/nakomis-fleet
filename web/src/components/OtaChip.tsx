import Chip from '@mui/material/Chip';
import type { OtaState } from '../api/types';
import { isStuck, OTA_LABELS, otaColour } from './format';

export function OtaChip({ state }: { state?: OtaState }) {
  if (!state) return null;
  const stuck = isStuck(state);
  const label = stuck ? 'No word from device' : OTA_LABELS[state.phase];
  const progress = state.phase === 'in_progress' && state.progress ? ` ${state.progress}%` : '';
  return (
    <Chip
      size="small"
      variant="outlined"
      color={stuck ? 'warning' : otaColour(state.phase)}
      label={`${label}${progress}${state.targetVersion && state.phase !== 'complete' ? ` → ${state.targetVersion}` : ''}`}
    />
  );
}
