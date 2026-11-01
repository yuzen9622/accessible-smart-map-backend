import type { RouteOperation } from "./route-operation";
import type { AgentLanguage } from "../../types/agent";

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Only server-committed effects and selected route facts become spoken claims. */
export function routeOperationSpeech(
  operation: RouteOperation,
  results: ReadonlyMap<number | string, unknown>,
  navigationActive: boolean,
  language: AgentLanguage,
): string | null {
  const english = language === "en";
  if (operation.action === "clarify") {
    if (operation.clarificationReason === "accessibility_conflict")
      return english
        ? "Please clarify the accessibility mode and travel mode. Will someone else drive, or would you prefer walking or public transport? Your existing accessibility needs will be preserved."
        : "請先確認通行模式與交通方式。是由他人接送，還是改用步行或大眾運輸？我會保留原有無障礙需求，確認後再規劃。";
    return english
      ? "Please clarify whether you want to plan a route, start navigation, or ask about route details. Your existing accessibility needs will be preserved."
      : "請確認這次要規劃路線、開始導航，還是詢問路線細節？我會保留原有無障礙需求，確認後再處理。";
  }
  const starts = operation.action === "start" || operation.startNavigation;
  const started =
    navigationActive &&
    (record(results.get("startNavigation"))?.ok === true ||
      [...results.values()].some((result) => {
        const value = record(result);
        return (
          value?.navigationStarted === true ||
          (operation.action === "start" && value?.ok === true)
        );
      }));
  // NavigationSession already owns the exact starting announcement and directions.
  if (started) return null;
  if (operation.action === "start")
    return english
      ? "Navigation could not be started. Please check the selected route."
      : "目前無法開始導航，請確認所選路線。";
  if (operation.action === "stop") {
    const stopped =
      record(results.get("stop"))?.ok === true && !navigationActive;
    return stopped
      ? english
        ? "Navigation has stopped. You can continue talking to me."
        : "已停止導航，您可以繼續語音對話。"
      : english
        ? "Navigation could not be stopped."
        : "目前未能停止導航。";
  }
  if (operation.action === "delegate") {
    const stepResults = [
      results.get("repeatNavStep"),
      results.get("advanceNavStep"),
    ].map(record);
    if (operation.delegateKind === "step" || stepResults.some(Boolean)) {
      if (stepResults.some((result) => result?.ok === true)) return null;
      return english
        ? "There is no navigation step available for that action."
        : "目前沒有可執行這個操作的導航步驟。";
    }
    const switched = record(results.get("confirmNavigationCandidateSwitch"));
    if (switched)
      return switched.ok === true
        ? null
        : english
          ? "The navigation route could not be changed."
          : "目前未能切換導航路線。";
    const proposed = record(results.get("proposeNavigationCandidate"));
    if (proposed) {
      if (proposed.ok !== true || typeof proposed.candidateNumber !== "number")
        return english
          ? "That route is not available for switching."
          : "目前無法切換至該候選路線。";
      const time =
        typeof proposed.totalMinutes === "number" &&
        Number.isFinite(proposed.totalMinutes)
          ? english
            ? `, approximately ${Math.ceil(proposed.totalMinutes)} minutes`
            : `，預估 ${Math.ceil(proposed.totalMinutes)} 分鐘`
          : "";
      return english
        ? `Route ${proposed.candidateNumber}${time} is available. The navigation route has not changed. Would you like to switch?`
        : `可切換至第 ${proposed.candidateNumber} 條路線${time}。目前尚未切換，要切換嗎？`;
    }
    if (operation.startNavigation)
      return english ? "Navigation has not started." : "目前未能開始導航。";
  }
  if (operation.action !== "plan" && operation.action !== "compare")
    return null;
  const names = english
    ? {
        drive: "Driving",
        motorcycle: "Motorcycling",
        transit: "Public transport",
        walk: "Walking",
      }
    : {
        drive: "開車",
        motorcycle: "騎機車",
        transit: "大眾運輸",
        walk: "步行",
      };
  const lines = operation.plans.map((plan, index) => {
    const result = record(results.get(index));
    const routes = Array.isArray(result?.routes)
      ? result.routes.map(record).filter((route) => route !== undefined)
      : [];
    const route =
      routes.find(
        (candidate) => candidate.routeId === result?.selectedRouteId,
      ) ?? routes[0];
    const name = names[plan.travelMode];
    if (result?.ok !== true || !route)
      return english
        ? `${name}: route planning was unsuccessful.`
        : `${name}路線未能完成規劃。`;
    const duration =
      typeof route.totalMinutes === "number" &&
      Number.isFinite(route.totalMinutes) &&
      route.totalMinutes >= 0
        ? Math.ceil(route.totalMinutes)
        : null;
    const durationText =
      duration === null
        ? ""
        : english
          ? `, approximately ${duration} minutes`
          : `，預估 ${duration} 分鐘`;
    const warningCount = Array.isArray(route.warnings)
      ? route.warnings.length
      : 0;
    const warnings = warningCount
      ? english
        ? ` Please review the ${warningCount} route notices.`
        : `請查看路線的 ${warningCount} 項提醒。`
      : "";
    return (
      (english
        ? `${name} route planned${durationText}.`
        : `已規劃${name}路線${durationText}。`) + warnings
    );
  });
  lines.push(
    starts
      ? english
        ? "Navigation has not started."
        : "目前未能開始導航。"
      : english
        ? "These are route previews only. Navigation has not started."
        : "目前只規劃路線，未開始導航。",
  );
  return lines.join(english ? " " : "");
}

export function operationSpeechPrompt(text: string): string {
  return `只逐字朗讀以下伺服器已核實的回覆，不得自行新增、刪減或執行工具。先前對話中的操作不代表本輪要求。回覆：${text}`;
}
