export type NavigationIntent = {
  kind:
    | "direct"
    | "informational"
    | "switch"
    | "confirm"
    | "reject"
    | "stop"
    | "start"
    | "other";
  candidateNumber?: number;
};

/** Conservative authorization, not a semantic replacement for the model. */
export function classifyNavigationIntent(text: string): NavigationIntent {
  const t = text.trim().toLowerCase();
  if (
    /(?:不要|先別|別|不想|不願|不用|不必|不需要|無需)(?:再|要|繼續)?(?:停止導航|結束導航|開始導航|導航|帶我去|領我去)|(?:don['’]?t|do not)(?:\s+(?:want(?:\s+you)?|need)\s+to)?\s+(?:navigate|take|stop|end|start)/i.test(
      t,
    )
  )
    return { kind: "other" };
  if (/不要換|別換|不換|不用了|取消|^(no|nope|reject|cancel)[.!\s]*$/i.test(t))
    return { kind: "reject" };
  if (
    /怎麼去|如何到|有哪些路線|比較|多久|how do i get|show.*routes|compare.*routes/i.test(
      t,
    )
  )
    return { kind: "informational" };
  if (/[?？]|嗎|是否|能否/.test(t)) return { kind: "other" };
  if (/停止導航|結束導航|stop navigation|end navigation/i.test(t))
    return { kind: "stop" };
  const ordinal = /第\s*([一二兩三四五六七八九十\d]+)\s*條/.exec(t);
  if (/換一條|另一條|換.*條|another route|different route/.test(t) || ordinal) {
    const number = ordinal
      ? Number(ordinal[1]) ||
        (
          {
            一: 1,
            二: 2,
            兩: 2,
            三: 3,
            四: 4,
            五: 5,
            六: 6,
            七: 7,
            八: 8,
            九: 9,
            十: 10,
          } as Record<string, number>
        )[ordinal[1]]
      : undefined;
    return { kind: "switch", ...(number ? { candidateNumber: number } : {}) };
  }
  if (/導航到|導航去|帶我去|領我去|\bnavigate\s+to\b|\btake me to\b/.test(t))
    return { kind: "direct" };
  if (/^(開始導航|開始帶路|start navigation)[。.!\s]*$/.test(t))
    return { kind: "start" };
  if (
    /^(好[，, ]*)?(換吧|就這條|確認|確定|可以|好的|好|yes|confirm|ok|okay)[。.!\s]*$/.test(
      t,
    )
  )
    return { kind: "confirm" };
  return { kind: "other" };
}
