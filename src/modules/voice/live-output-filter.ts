import type { VoiceOutputTrimConfig } from "../../config/voice-live";

/** Gemini Live output is 24 kHz mono PCM16. */
export const OUTPUT_PCM_BYTES_PER_MS = 48;
const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * Drops model audio once a turn has streamed more than `maxSilenceMs` of
 * consecutive non-speech. Gemini Live often keeps a turn open for seconds to
 * minutes of silence or hiss after the answer, and it arrives faster than
 * realtime, so the client would queue all of it ahead of the next answer.
 */
export interface TurnAudioStats {
  speechMs: number;
  keptSilenceMs: number;
  droppedMs: number;
}

export class OutputSilenceTrimmer {
  private silentMs = 0;
  private stats: TurnAudioStats = {
    speechMs: 0,
    keptSilenceMs: 0,
    droppedMs: 0,
  };

  constructor(private readonly config: VoiceOutputTrimConfig) {}

  /** @returns Whether this PCM16 chunk should be forwarded to the client. */
  accept(pcm: Buffer): boolean {
    const ms = pcm.length / OUTPUT_PCM_BYTES_PER_MS;
    if (this.isSpeech(pcm)) {
      this.silentMs = 0;
      this.stats.speechMs += ms;
      return true;
    }
    this.silentMs += ms;
    const keep = this.silentMs <= this.config.maxSilenceMs;
    if (keep) this.stats.keptSilenceMs += ms;
    else this.stats.droppedMs += ms;
    return keep;
  }

  /** @returns The current turn's audio so far, without ending the turn. */
  peek(): TurnAudioStats {
    return { ...this.stats };
  }

  /**
   * Call at every turn boundary so a new answer starts untrimmed.
   *
   * @returns What the finished turn's audio consisted of.
   */
  reset(): TurnAudioStats {
    const stats = this.stats;
    this.silentMs = 0;
    this.stats = { speechMs: 0, keptSilenceMs: 0, droppedMs: 0 };
    return stats;
  }

  private isSpeech(pcm: Buffer): boolean {
    const samples = Math.floor(pcm.length / 2);
    if (samples === 0) return false;
    let energy = 0;
    let crossings = 0;
    let previous = 0;
    for (let i = 0; i < samples; i++) {
      const sample = pcm.readInt16LE(i * 2);
      energy += Math.abs(sample);
      if (i > 0 && sample >= 0 !== previous >= 0) crossings++;
      previous = sample;
    }
    return (
      energy / samples >= this.config.speechLevel &&
      crossings / samples < this.config.speechMaxZeroCrossingRate
    );
  }
}

/**
 * Live transcribes its silent tail as runs of ". ". Keeps one short
 * punctuation piece after real text and drops the rest.
 *
 * @param transcript Model transcript of the current turn so far.
 * @param piece The next outputTranscription piece.
 * @returns The piece to append, or null to drop it.
 */
export function filterModelTranscriptPiece(
  transcript: string,
  piece: string,
): string | null {
  if (WORD_CHAR.test(piece)) return piece;
  if (!WORD_CHAR.test(transcript.slice(-1))) return null;
  return piece.trim() === "" ? piece : piece.trim().slice(0, 3);
}
