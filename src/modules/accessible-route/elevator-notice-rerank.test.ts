import { describe, expect, it } from "vitest";
import type { AccessibleRoute } from "../../types/route";
import { demoteElevatorNoticeRoutes } from "./elevator-notice-rerank";

function route(name: string, blockingOnRoute = 0): AccessibleRoute {
  return {
    routeName: name,
    hazardAdvisory: blockingOnRoute
      ? { onRoute: [], avoided: [], blockingOnRoute, penaltyPoints: 1000 }
      : undefined,
  } as unknown as AccessibleRoute;
}

const names = (routes: AccessibleRoute[]) => routes.map((r) => r.routeName);

describe("demoteElevatorNoticeRoutes", () => {
  it("moves an affected route behind unaffected ones for wheelchair users", () => {
    const [a, b, c] = [route("a"), route("b"), route("c")];
    const routes = [a, b, c];
    demoteElevatorNoticeRoutes(routes, new Set([a]), "wheelchair", false);
    expect(names(routes)).toEqual(["b", "c", "a"]);
  });

  it("applies when the caller requires elevators in any mode", () => {
    const [a, b] = [route("a"), route("b")];
    const routes = [a, b];
    demoteElevatorNoticeRoutes(routes, new Set([a]), "normal", true);
    expect(names(routes)).toEqual(["b", "a"]);
  });

  it("keeps the order for modes that do not depend on elevators", () => {
    const [a, b] = [route("a"), route("b")];
    const routes = [a, b];
    demoteElevatorNoticeRoutes(routes, new Set([a]), "normal", false);
    expect(names(routes)).toEqual(["a", "b"]);
  });

  it("never lifts a route with a blocking hazard above an affected one", () => {
    const [a, b] = [route("a"), route("b", 1)];
    const routes = [a, b];
    demoteElevatorNoticeRoutes(routes, new Set([a]), "wheelchair", false);
    expect(names(routes)).toEqual(["a", "b"]);
  });

  it("keeps the earliest-future guarantee untouched", () => {
    const [a, b] = [route("a"), route("b")];
    (a as { _isFutureScheduled?: boolean })._isFutureScheduled = true;
    const routes = [a, b];
    demoteElevatorNoticeRoutes(routes, new Set([a]), "wheelchair", false);
    expect(names(routes)).toEqual(["a", "b"]);
  });
});
