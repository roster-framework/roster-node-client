import type {SessionRecord} from './session-delivery.js';

export type EnginePhase = 'started' | 'returned' | 'interrupted';

// Runtime assigns the phase, identity and time. No agent output or error text
// enters this fact. Returned is not a committed Core business result.
export function engineObservation(phase: EnginePhase, durationMS: number, at: string): SessionRecord {
  if (!['started','returned','interrupted'].includes(phase) || !Number.isSafeInteger(durationMS) || durationMS < 0 ||
      (phase === 'started' && durationMS !== 0) || !Number.isFinite(Date.parse(at)))
    throw new Error('Invalid engine observation');
  return {id:'engine.'+phase,kind:'note',at,text:JSON.stringify({protocol:'roster-engine-observation/1',phase,duration_ms:durationMS})};
}
