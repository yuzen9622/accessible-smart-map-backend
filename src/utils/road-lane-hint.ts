import type { RoadLane } from "../types/road-guidance";
import type { AgentLanguage } from "../types/agent";

const ZH_COUNT = [
  "",
  "一",
  "兩",
  "三",
  "四",
  "五",
  "六",
  "七",
  "八",
  "九",
  "十",
];
const ZH_ORDINAL = [
  "",
  "一",
  "二",
  "三",
  "四",
  "五",
  "六",
  "七",
  "八",
  "九",
  "十",
];

/**
 * Which lanes to take before a maneuver, counted from the left as Valhalla
 * lists them. Uses the preferred lanes, or the usable ones when none is
 * preferred; says nothing when every lane works or none is recommended.
 */
export function roadLaneHint(
  lanes: RoadLane[] | undefined,
  language: AgentLanguage = "zh-TW",
): string | undefined {
  if (!lanes?.length || lanes.length > 10) return undefined;
  const pick = (kind: RoadLane["recommendation"]) =>
    lanes.flatMap((lane, index) =>
      lane.recommendation === kind ? [index] : [],
    );
  const chosen = pick("preferred").length ? pick("preferred") : pick("usable");
  if (!chosen.length || chosen.length === lanes.length) return undefined;
  const first = chosen[0];
  const last = chosen.at(-1)!;
  const contiguous = last - first + 1 === chosen.length;
  const count = chosen.length;
  const en = language === "en";
  if (contiguous && last === lanes.length - 1)
    return en
      ? count === 1
        ? "use the right lane"
        : `use the right ${count} lanes`
      : count === 1
        ? "靠最右側車道"
        : `靠右側${ZH_COUNT[count]}個車道`;
  if (contiguous && first === 0)
    return en
      ? count === 1
        ? "use the left lane"
        : `use the left ${count} lanes`
      : count === 1
        ? "靠最左側車道"
        : `靠左側${ZH_COUNT[count]}個車道`;
  const positions = chosen.map((index) => index + 1);
  if (en)
    return positions.length === 1
      ? `use lane ${positions[0]} from the left`
      : contiguous
        ? `use lanes ${first + 1}–${last + 1} from the left`
        : `use lanes ${positions.join(", ")} from the left`;
  const ordinal = (n: number) => `第${ZH_ORDINAL[n]}`;
  return positions.length === 1
    ? `走左邊數來${ordinal(positions[0])}車道`
    : contiguous
      ? `走左邊數來${ordinal(first + 1)}到${ordinal(last + 1)}車道`
      : `走左邊數來${positions.map(ordinal).join("、")}車道`;
}

/** Appends the lane hint to a turn instruction once. */
export function withLaneHint(
  instruction: string,
  hint: string | undefined,
  language: AgentLanguage = "zh-TW",
): string {
  if (!hint) return instruction;
  const suffix = language === "en" ? `, ${hint}` : `，請${hint}`;
  if (instruction.includes(suffix)) return instruction;
  const trimmed = instruction.replace(/[。.]\s*$/, "");
  return trimmed + suffix;
}
