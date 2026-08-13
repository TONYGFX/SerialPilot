/**
 * Defines user-configured waveform channels and derived numeric samples.
 * These contracts describe a frontend projection of immutable RX frames; raw
 * bytes and serial-session audit records remain owned by the Rust core.
 */

/** A user-defined named value captured from decoded RX text. */
export type WaveChannel = {
  id: string;
  name: string;
  color: string;
  enabled: boolean;
};

/** One captured numeric value, linked to its originating serial frame. */
export type WaveSample = {
  channelId: string;
  cursor: number;
  timestampMs: number;
  value: number;
};

/** Controls local to the waveform workbench rather than the serial core. */
export type WaveformSettings = {
  showLatestMarker: boolean;
};
