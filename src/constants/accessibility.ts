/**
 * Shared accessibility/routing constants — values consumed across more than one
 * file in the accessible-route module. Per-file scoring weights, cache TTLs and
 * thresholds stay co-located with the logic that tunes them.
 */

export const FACILITY_LABELS: Record<number, string> = {
  1: "有電梯",
  2: "有電扶梯",
  3: "有無障礙廁所",
  4: "有無障礙停車位",
  5: "有導盲磚",
};
