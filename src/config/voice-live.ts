export interface VoiceOutputTrimConfig {
  /** Longest run of non-speech model audio forwarded before trimming starts. */
  maxSilenceMs: number;
  /** Mean absolute PCM16 amplitude a chunk needs to count as speech. */
  speechLevel: number;
  /** Zero-crossing rate above which a loud chunk is hiss, not speech. */
  speechMaxZeroCrossingRate: number;
}

// Natural pauses inside Live speech measured ≤ 640 ms; the degenerate tail
// after an answer runs from seconds to minutes of silence or hiss.
const DEFAULTS: VoiceOutputTrimConfig = {
  maxSilenceMs: 1_500,
  speechLevel: 300,
  speechMaxZeroCrossingRate: 0.5,
};

function readNumber(
  name: string,
  fallback: number,
  valid: (n: number) => boolean,
  expected: string,
): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !valid(parsed)) {
    throw new Error(`Invalid ${name}: expected ${expected}, got "${raw}"`);
  }
  return parsed;
}

/**
 * Thresholds for trimming the silent/hiss tail Gemini Live appends to answers.
 *
 * @returns Defaults overridden by VOICE_OUTPUT_MAX_SILENCE_MS,
 *   VOICE_OUTPUT_SPEECH_LEVEL and VOICE_OUTPUT_SPEECH_MAX_ZCR.
 * @throws When an env value is not a number in its valid range.
 */
export function getVoiceOutputTrimConfig(): VoiceOutputTrimConfig {
  return {
    maxSilenceMs: readNumber(
      "VOICE_OUTPUT_MAX_SILENCE_MS",
      DEFAULTS.maxSilenceMs,
      (n) => n > 0,
      "a positive number of milliseconds",
    ),
    speechLevel: readNumber(
      "VOICE_OUTPUT_SPEECH_LEVEL",
      DEFAULTS.speechLevel,
      (n) => n > 0 && n < 32_768,
      "a PCM16 amplitude between 0 and 32768",
    ),
    speechMaxZeroCrossingRate: readNumber(
      "VOICE_OUTPUT_SPEECH_MAX_ZCR",
      DEFAULTS.speechMaxZeroCrossingRate,
      (n) => n > 0 && n <= 1,
      "a rate in (0, 1]",
    ),
  };
}

// Live accepts any voiceName and silently falls back to its default for an
// unknown one, so a typo would go unnoticed without this list.
const LIVE_PREBUILT_VOICES = [
  "Zephyr",
  "Puck",
  "Charon",
  "Kore",
  "Fenrir",
  "Leda",
  "Orus",
  "Aoede",
  "Callirrhoe",
  "Autonoe",
  "Enceladus",
  "Iapetus",
  "Umbriel",
  "Algieba",
  "Despina",
  "Erinome",
  "Algenib",
  "Rasalgethi",
  "Laomedeia",
  "Achernar",
  "Alnilam",
  "Schedar",
  "Gacrux",
  "Pulcherrima",
  "Achird",
  "Zubenelgenubi",
  "Vindemiatrix",
  "Sadachbia",
  "Sadaltager",
  "Sulafat",
] as const;

/**
 * Prebuilt Gemini Live voice for every voice session.
 *
 * @returns The canonical voice name from GEMINI_LIVE_VOICE (any letter case),
 *   or undefined to keep Gemini's default voice.
 * @throws When GEMINI_LIVE_VOICE names no prebuilt voice.
 */
export function getLiveVoiceName(): string | undefined {
  const raw = process.env.GEMINI_LIVE_VOICE?.trim();
  if (!raw) return undefined;
  const voice = LIVE_PREBUILT_VOICES.find(
    (name) => name.toLowerCase() === raw.toLowerCase(),
  );
  if (!voice) {
    throw new Error(
      `Invalid GEMINI_LIVE_VOICE: expected one of ${LIVE_PREBUILT_VOICES.join(", ")}, got "${raw}"`,
    );
  }
  return voice;
}
