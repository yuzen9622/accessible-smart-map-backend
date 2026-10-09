import { getNavigationEnvelopeByToken } from "../accessible-route/route-token.service";
import { AGENT_ROUTE_ERRORS } from "../../constants/agent-route";
import type {
  RouteContextInput,
  RouteContextResult,
  RouteContextFailure,
  RoutingPreferences,
} from "../../types/agent-route";
import type { AgentToolExecutor } from "../../types/agent";
import {
  projectRouteForModel,
  projectToolResult,
} from "../../utils/agent-route-projection";

const isRecord = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const ROUTE_CONTEXT_LOOKUP_TIMEOUT_MS = 5_000;
const PREFERENCE_KEYS = [
  "mode",
  "transitPreference",
  "departureTime",
  "avoidStairs",
  "requireElevator",
] as const;

/** Per conversation selection; never changes the active turn-by-turn navigation. */
export class RouteConversationContext {
  private selected: Record<string, any> | undefined;
  private tripPreferences: RoutingPreferences = {};
  private failure: RouteContextFailure | undefined;
  revision = 0;
  constructor(private readonly defaults: RoutingPreferences = {}) {}

  get token(): string | undefined {
    return this.selected?.routeToken;
  }
  get identity(): RouteContextResult {
    if (this.failure) return { ok: false, reason: this.failure };
    return {
      ok: true,
      routeId: this.selected?.routeId ?? null,
      navigationId: this.selected?.navigationId ?? null,
      routeVersion: this.selected?.routeVersion ?? null,
    };
  }
  get preferences(): RoutingPreferences {
    return { ...this.defaults, ...this.tripPreferences };
  }
  get prompt(): string {
    return `\n\n【目前查看的路線】${JSON.stringify(this.failure ? { ok: false, reason: this.failure, message: AGENT_ROUTE_ERRORS[this.failure] } : this.selected ? projectRouteForModel({ route: this.selected, effectivePreferences: this.tripPreferences }) : { selected: false })}\n只有 selected=true 或 route 存在才有目前查看的路線；無選擇或讀取失敗時不得把歷史摘要冒充目前選擇。目前查看與正在導航可能不同；若目前有提供 getActiveNavigationContext 工具，導航中的問題須先查其脈絡；未提供時不可推測導航進度。工具的新規劃結果會更新目前查看的路線；詳細步驟只能查已選路線，不能重新規劃。\n【規劃預設】${JSON.stringify(this.preferences)}；只在使用者未明示時採用，勿用一般模式覆蓋已確認的無障礙需求。`;
  }
  error(): string {
    const reason =
      this.failure ??
      (this.selected ? "ROUTE_CONTEXT_UNAVAILABLE" : "ROUTE_CONTEXT_REQUIRED");
    return JSON.stringify({
      ok: false,
      reason,
      error: AGENT_ROUTE_ERRORS[reason],
    });
  }
  async set(input: RouteContextInput): Promise<RouteContextResult> {
    const revision = ++this.revision;
    this.selected = undefined;
    this.tripPreferences = {};
    this.failure = undefined;
    if (input === null) return this.identity;
    this.failure = "ROUTE_CONTEXT_UNAVAILABLE";
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const envelope = await Promise.race([
        getNavigationEnvelopeByToken(input.routeToken),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Route context lookup timed out")),
            ROUTE_CONTEXT_LOOKUP_TIMEOUT_MS,
          );
        }),
      ]);
      if (revision !== this.revision)
        return { ok: false, reason: "STALE_SELECTION" };
      if (!envelope) {
        this.failure = "INVALID_ROUTE_TOKEN";
        return this.identity;
      }
      this.selected = {
        ...envelope.route,
        routeToken: input.routeToken,
        navigationId: envelope.navigationId,
        routeVersion: envelope.routeVersion,
      };
      this.tripPreferences = this.pickPreferences(envelope.canonicalRequest);
      this.failure = undefined;
    } catch {
      if (revision !== this.revision)
        return { ok: false, reason: "STALE_SELECTION" };
    } finally {
      clearTimeout(timeout);
    }
    return this.identity;
  }
  adopt(result: unknown): void {
    if (
      !isRecord(result) ||
      result.ok !== true ||
      !Array.isArray(result.routes)
    )
      return;
    const selected = result.routes.find(
      (route: unknown) =>
        isRecord(route) && route.routeId === result.selectedRouteId,
    );
    if (!selected) return;
    this.selected = selected;
    this.tripPreferences = this.pickPreferences(
      result.effectivePreferences ?? {},
    );
    this.failure = undefined;
    this.revision++;
  }
  private pickPreferences(value: Record<string, any>): RoutingPreferences {
    return Object.fromEntries(
      PREFERENCE_KEYS.filter((key) => value[key] !== undefined).map((key) => [
        key,
        value[key],
      ]),
    );
  }
}

/** Wrap the local executor once for both transports, without a second planner call. */
export function createRouteAwareExecutor(
  context: RouteConversationContext,
  raw: AgentToolExecutor,
): AgentToolExecutor {
  return async (name, args, location, userId, options) => {
    const revision = context.revision;
    if (name === "getNavInstructions" && !context.token) return context.error();
    const effectiveArgs =
      name === "planAccessibleRoute"
        ? {
            ...context.preferences,
            ...Object.fromEntries(
              Object.entries(args).filter(([, value]) => value !== undefined),
            ),
          }
        : args;
    const output = await raw(name, effectiveArgs, location, userId, {
      ...options,
      routeToken: context.token,
    });
    if (revision !== context.revision || options?.isCurrent?.() === false)
      return JSON.stringify({
        ok: false,
        reason: "STALE_SELECTION",
        error: AGENT_ROUTE_ERRORS.STALE_SELECTION,
      });
    let parsed: unknown;
    if (typeof output !== "string") parsed = output.clientResult;
    else {
      try {
        parsed = JSON.parse(output);
      } catch {
        return output;
      }
    }
    if (name === "planAccessibleRoute") context.adopt(parsed);
    return projectToolResult(parsed);
  };
}
