const QUIET_MS = 1_200;
const RECENT_AUDIO_MS = 1_000;
const SAMPLES_PER_MS = 16;
const VOICED_MEAN_ABSOLUTE = 100;

export function createInputTurnBoundary(options: {
  onSettled(isCurrent: () => boolean): void;
}): {
  transcriptReceived(): void;
  audioReceived(pcm: Buffer): void;
  reset(): void;
  dispose(): void;
} {
  let generation = 0;
  let armed = false;
  let disposed = false;
  let lastTranscriptAt = 0;
  let lastAudioAt: number | null = null;
  let quietSince: number | null = null;
  let quietSamples = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function clearTimer(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function reset(): void {
    generation += 1;
    clearTimer();
    armed = false;
    lastAudioAt = null;
    quietSince = null;
    quietSamples = 0;
  }

  function schedule(): void {
    if (
      !armed ||
      disposed ||
      timer !== null ||
      quietSince === null ||
      quietSamples < QUIET_MS * SAMPLES_PER_MS
    )
      return;
    const dueAt = Math.max(lastTranscriptAt + QUIET_MS, quietSince + QUIET_MS);
    timer = setTimeout(
      () => {
        timer = null;
        const now = Date.now();
        if (
          !armed ||
          disposed ||
          lastAudioAt === null ||
          now - lastAudioAt > RECENT_AUDIO_MS ||
          quietSince === null ||
          now - quietSince < QUIET_MS ||
          now - lastTranscriptAt < QUIET_MS ||
          quietSamples < QUIET_MS * SAMPLES_PER_MS
        )
          return;
        reset();
        const settledGeneration = generation;
        options.onSettled(() => !disposed && generation === settledGeneration);
      },
      Math.max(0, dueAt - Date.now()),
    );
  }

  return {
    transcriptReceived() {
      if (disposed) return;
      generation += 1;
      if (!armed) reset();
      armed = true;
      lastTranscriptAt = Date.now();
      clearTimer();
      schedule();
    },
    audioReceived(pcm) {
      if (disposed || !pcm.length || pcm.length % 2) return;
      const samples = pcm.length / 2;
      let magnitude = 0;
      for (let offset = 0; offset < pcm.length; offset += 2) {
        magnitude += Math.abs(pcm.readInt16LE(offset));
      }
      const now = Date.now();
      if (magnitude / samples >= VOICED_MEAN_ABSOLUTE) {
        generation += 1;
        if (armed) lastAudioAt = now;
        quietSince = null;
        quietSamples = 0;
        clearTimer();
        return;
      }
      if (!armed) return;
      lastAudioAt = now;
      quietSince ??= now;
      quietSamples = Math.min(
        QUIET_MS * SAMPLES_PER_MS,
        quietSamples + samples,
      );
      // Ongoing silence keeps the freshness check current without postponing an existing timer.
      schedule();
    },
    reset,
    dispose() {
      disposed = true;
      reset();
    },
  };
}
