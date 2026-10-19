import { normalizeVoiceTranscript } from "./transcript-normalizer";

/** Only whole-utterance requests may end voice; mentions and negations cannot. */
export function isExplicitEndIntent(text: string | null | undefined): boolean {
  const normalized = normalizeVoiceTranscript(text ?? "").toLowerCase();
  const compact = normalized.replace(/[\s，。、！？!?,.~～…「」"'’]/g, "");
  if (!compact || compact.length > 16) return false;
  if (
    /(不要|不用|別|不想|還不|還沒|不必|沒有要|don't|dont|not|no)/.test(compact)
  )
    return false;
  // Polite requests are questions syntactically, but still explicit commands.
  if (
    /^(可以|能不能|可不可以)(幫我)?(結束語音|結束對話|關閉語音|關掉語音|掛斷|結束通話)(嗎|呢)?$/.test(
      compact,
    )
  )
    return true;
  if (
    /^(請|麻煩)(幫我)?(結束語音|結束對話|關閉語音|關掉語音|掛斷|結束通話)(吧)?$/.test(
      compact,
    )
  )
    return true;
  if (
    /[?？]|嗎|呢|什麼|怎麼|哪|如何|多少|幾|為什麼|what|how|where|when|why/.test(
      normalized,
    )
  )
    return false;
  return /^(好|好的|嗯|那|ok|okay)?(就)?(再見|拜拜|掰掰|bye|byebye|goodbye|結束語音|結束對話|關閉語音|關掉語音|掛斷|結束通話|先這樣|就這樣|沒事了|沒有別的事了|endvoice|endthevoicesession|thatsall)(了)?(謝謝|謝啦|謝謝你|thanks|thankyou)?(再見|拜拜|bye)?(吧|喔|囉|啦)?$/.test(
    compact,
  );
}
