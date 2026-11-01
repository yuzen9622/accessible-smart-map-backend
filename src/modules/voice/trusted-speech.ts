import { synthesizeVoice } from "../../adapters/voice-synthesis.adapter";

export interface TrustedSpeechRequest {
  text: string;
  voiceName: string;
  isCurrent: () => boolean;
  onText: (text: string) => void;
  onAudio: (pcm: Buffer) => boolean;
  onComplete: () => void;
  onFailure: () => void;
}

/** One cancellable PCM producer; provider Live events never complete this job. */
export function createTrustedSpeech() {
  let current: {
    controller: AbortController;
    timer: ReturnType<typeof setTimeout> | null;
  } | null = null;
  const cancel = () => {
    const old = current;
    current = null;
    if (old?.timer) clearTimeout(old.timer);
    old?.controller.abort();
  };
  return {
    cancel,
    get busy() {
      return current !== null;
    },
    speak(request: TrustedSpeechRequest): void {
      cancel();
      const job = {
        controller: new AbortController(),
        timer: null as ReturnType<typeof setTimeout> | null,
      };
      current = job;
      const valid = () => {
        if (current !== job || job.controller.signal.aborted) return false;
        if (!request.isCurrent()) {
          cancel();
          return false;
        }
        return true;
      };
      const fail = () => {
        if (!valid()) return;
        current = null;
        job.controller.abort();
        request.onFailure();
      };
      void synthesizeVoice(request.text, {
        voiceName: request.voiceName,
        signal: job.controller.signal,
      })
        .then(({ pcm }) => {
          if (!valid()) return;
          let offset = 0;
          request.onText(request.text);
          const sendNext = () => {
            job.timer = null;
            if (!valid()) return;
            if (offset >= pcm.length) {
              current = null;
              request.onComplete();
              return;
            }
            const chunk = pcm.subarray(offset, offset + 1920); // 40ms, mono PCM16 at 24kHz
            if (!request.onAudio(chunk)) {
              fail();
              return;
            }
            offset += chunk.length;
            job.timer = setTimeout(sendNext, chunk.length / 48);
          };
          sendNext();
        })
        .catch(fail);
    },
  };
}
