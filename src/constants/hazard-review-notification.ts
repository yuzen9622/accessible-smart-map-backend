import type { HazardReviewNoticeResult } from "../types/hazard-review-notification";

export const HAZARD_REVIEW_PUSH = {
  pollMs: 5_000,
  leaseMs: 60_000,
  lifetimeMs: 24 * 60 * 60_000,
  retryBaseMs: 15_000,
  retryCapMs: 15 * 60_000,
  batchSize: 10,
} as const;

const zh: Record<HazardReviewNoticeResult, string> = {
  ai_supported: "照片審核已完成，影像可支持此次通報。請開啟 App 查看結果。",
  ai_needs_evidence: "此次通報需要更多佐證。請開啟 App 查看審核結果。",
  ai_unsupported: "目前照片未能支持此次通報。請開啟 App 查看審核結果。",
  ai_failed: "此次通報的自動審核未能完成。請開啟 App 查看狀態。",
  manual_verified: "此次通報已通過人工審核。請開啟 App 查看結果。",
  manual_rejected: "此次通報未通過人工審核。請開啟 App 查看結果。",
  legacy_verified: "此次通報的審核結果已更新。請開啟 App 查看結果。",
  legacy_suspicious: "此次通報需要進一步審核。請開啟 App 查看狀態。",
  legacy_rejected: "此次通報未通過照片審核。請開啟 App 查看結果。",
};
const en: Record<HazardReviewNoticeResult, string> = {
  ai_supported:
    "Photo review is complete. The image supports your report. Open the app for details.",
  ai_needs_evidence:
    "Your report needs more evidence. Open the app to view the review result.",
  ai_unsupported:
    "The current photo does not support your report. Open the app to view the review result.",
  ai_failed:
    "Automatic review could not be completed. Open the app to check your report.",
  manual_verified:
    "Your report passed manual review. Open the app for details.",
  manual_rejected:
    "Your report did not pass manual review. Open the app for details.",
  legacy_verified:
    "Your report review has been updated. Open the app for details.",
  legacy_suspicious:
    "Your report needs further review. Open the app to check its status.",
  legacy_rejected:
    "Your report did not pass photo review. Open the app for details.",
};
export const HAZARD_REVIEW_PUSH_COPY = {
  "zh-TW": { title: "危險通報審核更新", bodies: zh },
  en: { title: "Hazard report review update", bodies: en },
};
