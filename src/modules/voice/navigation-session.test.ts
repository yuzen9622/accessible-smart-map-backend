import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccessibleRoute, DriveLeg, WalkLeg } from "../../types/route";
import {
  NavProgressSchema,
  NavResumeOkMessageSchema,
  type NavProgressEvent,
} from "./voice.ws.schema";
import type { NavigationSessionSnapshot } from "../accessible-route/navigation-state.repository";
import {
  NavigationSession,
  distanceToPolylineM,
  haversineLngLat,
  MAX_LOOKAHEAD_STEPS,
} from "./navigation-session";

const coord = (lng: number, lat = 25): [number, number] => [lng, lat];

function walkLeg(
  points: [number, number][],
  withSteps = true,
  from = "起點",
  to = "終點",
): WalkLeg {
  return {
    type: "WALK",
    from,
    to,
    distanceM: 100,
    minutesEst: 2,
    polyline: points,
    a11yFacilities: [],
    maxSlopePercent: null,
    crossings: null,
    crossingsWithCurbRamp: null,
    minPathWidthCm: null,
    surfaceType: "unknown",
    restPoints: [],
    ...(withSteps
      ? {
          steps: points.map((location, index) => ({
            relativeDirection:
              index === 0 ? "DEPART" : index % 2 === 0 ? "LEFT" : "RIGHT",
            absoluteDirection: null,
            streetName: `道路${index}`,
            bogusName: false,
            area: false,
            stairs: false,
            steepSlope: false,
            distanceM: 20,
            location,
          })),
        }
      : {}),
  };
}

function driveLeg(
  points: [number, number][],
  type: "DRIVE" | "MOTORCYCLE" = "DRIVE",
  overrides: Partial<DriveLeg> = {},
): DriveLeg {
  const first = points[0] ?? coord(121);
  const last = points.at(-1) ?? first;
  return {
    type,
    from: { lat: first[1], lng: first[0] },
    to: { lat: last[1], lng: last[0] },
    distanceM: 1000,
    durationMin: 5,
    polyline: points,
    steps: points.slice(0, -1).map((location, index) => ({
      instruction: `車行指示${index}`,
      distanceM: 200,
      durationMin: 1,
      polyline: [location, points[index + 1]],
      maneuver: index === 0 ? "DEPART" : "TURN_LEFT",
    })),
    ...overrides,
  };
}

function route(legs: AccessibleRoute["legs"]): AccessibleRoute {
  return {
    routeId: "r1",
    routeName: "測試路線",
    totalMinutes: 10,
    transferCount: 0,
    legs,
    accessibilityHighlights: [],
  };
}

function bus(points: [number, number][], from = "甲站", to = "乙站") {
  return {
    type: "BUS" as const,
    routeName: "307",
    departureStop: from,
    arrivalStop: to,
    waitInfo: { time: null, source: "unavailable" as const },
    estimatedWaitMinutes: 0,
    direction: 0 as const,
    polyline: points,
    departureStopA11y: [],
    arrivalStopA11y: [],
  };
}

function metro(points: [number, number][], from = "乙站", to = "丙站") {
  return {
    type: "METRO" as const,
    railSystem: "TRTC",
    lineId: "BL",
    lineName: "板南線",
    lineUid: "TRTC-BL",
    departureStation: from,
    arrivalStation: to,
    departureStationUid: "A",
    arrivalStationUid: "B",
    direction: 0 as const,
    stopsCount: 2,
    rideMinutes: 3,
    waitInfo: { time: null, source: "unavailable" as const },
    estimatedWaitMinutes: 0,
    polyline: points,
    departureStationA11y: [],
    arrivalStationA11y: [],
    facilityHighlights: [],
  };
}

const pos = (p: [number, number], accuracy?: number) => ({
  longitude: p[0],
  latitude: p[1],
  ...(accuracy === undefined ? {} : { accuracy }),
});

describe("NavigationSession pure domain state", () => {
  it("returns NO_ROUTE_ARMED without nav.start", () => {
    const effect = new NavigationSession().start();
    expect(effect.ok).toBe(false);
    expect(effect.events).toEqual([
      { type: "nav.error", code: "NO_ROUTE_ARMED", message: "尚未選擇路線" },
    ]);
  });

  it("emits the public nav.start DTO only and waits for a geofence before speaking", () => {
    const start = coord(121);
    const end = coord(121.001);
    const nav = new NavigationSession();
    nav.armRoute(route([walkLeg([start, end])]));
    const effect = nav.start();
    expect(effect.events[0]).toMatchObject({
      type: "nav.start",
      currentStepIndex: 0,
      totalSteps: 3,
    });
    const firstStep = (effect.events[0] as any).steps[0];
    expect(Object.keys(firstStep).sort()).toEqual(
      [
        "bearing",
        "distanceM",
        "index",
        "instruction",
        "isTransit",
        "legType",
        "relativeDirection",
        "streetName",
        "type",
      ].sort(),
    );
    expect(nav.takeNextSpeech()).toBeNull();
    nav.onPosition(pos(start));
    expect(nav.takeNextSpeech()).toBe(
      "沿「道路0」出發，續行約 20 公尺，方位約 90 度（東）",
    );
  });

  it("advances WALK targets, flushes null arrive text, then emits arrived + stop", () => {
    const start = coord(121);
    const end = coord(121.001);
    const nav = new NavigationSession();
    nav.armRoute(route([walkLeg([start, end])]));
    nav.start(pos(start));
    nav.takeNextSpeech();
    nav.onTurnComplete();
    const finish = nav.onPosition(pos(end));
    expect(finish.events.map((event) => event.type)).toEqual([
      "nav.step",
      "nav.arrived",
      "nav.stop",
    ]);
    expect(nav.takeNextSpeech()).toContain("您已抵達目的地");
  });

  it("anchors transit at board/alight points and resumes the following WALK leg", () => {
    const walkStart = coord(121);
    const board = coord(121.001);
    const alight = coord(121.01);
    const destination = coord(121.011);
    const nav = new NavigationSession();
    nav.armRoute(
      route([
        walkLeg([walkStart, board]),
        bus([board, alight]),
        walkLeg([alight, destination], true, "乙站", "終點"),
      ]),
    );
    nav.start(pos(walkStart));
    nav.onPosition(pos(board));
    const boardEffect = nav.onPosition(pos(board));
    expect(
      boardEffect.events.some((event) => event.type === "nav.transit"),
    ).toBe(true);
    const alightEffect = nav.onPosition(pos(alight));
    expect(
      alightEffect.events.some((event) => event.type === "nav.transit"),
    ).toBe(false);
    const walkEffect = nav.onPosition(pos(alight));
    expect(walkEffect.events.some((event) => event.type === "nav.step")).toBe(
      true,
    );
  });

  it("announces consecutive BUS to METRO at the real transfer point", () => {
    const a = coord(121);
    const transfer = coord(121.01);
    const c = coord(121.02);
    const nav = new NavigationSession();
    nav.armRoute(route([bus([a, transfer]), metro([transfer, c])]));
    const start = nav.start(pos(a));
    expect(
      start.events.filter((event) => event.type === "nav.transit"),
    ).toHaveLength(1);
    const atTransfer = nav.onPosition(pos(transfer));
    const transits = atTransfer.events.filter(
      (event) => event.type === "nav.transit",
    ) as any[];
    expect(transits).toHaveLength(1);
    expect(transits[0].leg.mode).toBe("METRO");
    expect(
      atTransfer.events.some((event) => event.type === "nav.arrived"),
    ).toBe(false);
  });

  it("exposes the upcoming/current transit context without route geometry", () => {
    const walkStart = coord(121);
    const board = coord(121.001);
    const alight = coord(121.01);
    const destination = coord(121.011);
    const nav = new NavigationSession();
    nav.armRoute(
      route([
        walkLeg([walkStart, board]),
        bus([board, alight], "甲站", "乙站"),
        walkLeg([alight, destination], true, "乙站", "目的地"),
      ]),
    );

    expect(nav.getConversationContext()).toEqual({ active: false });
    nav.start(pos(walkStart));
    expect(nav.getConversationContext()).toMatchObject({
      active: true,
      destination: "目的地",
      transit: {
        relation: "upcoming",
        mode: "BUS",
        routeName: "307",
        from: "甲站",
        to: "乙站",
        direction: 0,
      },
    });
    expect(nav.getConversationContext()).not.toHaveProperty("polyline");

    nav.onPosition(pos(board));
    nav.onPosition(pos(board));
    expect(nav.getConversationContext().transit?.relation).toBe("current");
    nav.onPosition(pos(alight));
    expect(nav.getConversationContext().transit).toBeUndefined();
  });

  it("suppresses off-route warnings while riding transit", () => {
    const board = coord(121);
    const alight = coord(121.01);
    const far = coord(122, 26);
    const nav = new NavigationSession();
    nav.armRoute(route([bus([board, alight])]));
    nav.start(pos(board));
    for (let i = 0; i < 5; i++) {
      expect(
        nav
          .onPosition(pos(far))
          .events.some((event) => event.type === "nav.offroute"),
      ).toBe(false);
    }
  });

  it("uses capped GPS accuracy to expand a WALK geofence", () => {
    const target = coord(121.0005);
    const nav = new NavigationSession();
    nav.armRoute(route([walkLeg([target, coord(121.001)])]));
    nav.start();
    const roughlyFortyMetresAway = coord(121.0001);
    const effect = nav.onPosition(pos(roughlyFortyMetresAway, 30));
    expect(effect.events.some((event) => event.type === "nav.step")).toBe(true);
  });

  it("synthesizes a terminal geofence for a WALK leg without steps", () => {
    const start = coord(121);
    const end = coord(121.002);
    const nav = new NavigationSession();
    nav.armRoute(route([walkLeg([start, end], false)]));
    const atStart = nav.start(pos(start));
    expect(atStart.events.some((event) => event.type === "nav.arrived")).toBe(
      false,
    );
    const atEnd = nav.onPosition(pos(end));
    expect(atEnd.events.some((event) => event.type === "nav.arrived")).toBe(
      true,
    );
  });

  it("rejects malformed terminal geometry, including road legs", () => {
    const same = coord(121);
    for (const invalid of [
      route([walkLeg([same, same], false)]),
      route([bus([same]) as any]),
      route([driveLeg([same])]),
      route([driveLeg([same, same])]),
      route([
        driveLeg([same, coord(121.01)], "MOTORCYCLE", {
          steps: [
            {
              instruction: "出發",
              distanceM: 10,
              durationMin: 1,
              polyline: [],
              maneuver: "DEPART",
            },
          ],
        }),
      ]),
    ]) {
      const nav = new NavigationSession();
      nav.armRoute(invalid);
      const effect = nav.start();
      expect(effect.events[0]).toMatchObject({
        type: "nav.error",
        code: "NAV_ROUTE_INVALID",
      });
    }
  });

  it("arrives only at the alight point for a transit-only route", () => {
    const board = coord(121);
    const alight = coord(121.01);
    const nav = new NavigationSession();
    nav.armRoute(route([bus([board, alight])]));
    const boarded = nav.start(pos(board));
    expect(boarded.events.some((event) => event.type === "nav.transit")).toBe(
      true,
    );
    expect(boarded.events.some((event) => event.type === "nav.arrived")).toBe(
      false,
    );
    const finished = nav.onPosition(pos(alight));
    expect(finished.events.map((event) => event.type)).toContain("nav.arrived");
    expect(finished.events).toContainEqual({
      type: "nav.stop",
      reason: "arrived",
    });
  });

  it("bounds skip-ahead to MAX_LOOKAHEAD_STEPS and never reaches a nearby loop end in one sample", () => {
    const points = [
      coord(121),
      coord(121.00005),
      coord(121.0001),
      coord(121.00015),
    ];
    const nav = new NavigationSession();
    nav.armRoute(route([walkLeg(points)]));
    nav.start();
    const effect = nav.onPosition(pos(points[3]));
    const steps = effect.events.filter(
      (event) => event.type === "nav.step",
    ) as any[];
    expect(steps.at(-1)?.currentStepIndex).toBeLessThanOrEqual(
      MAX_LOOKAHEAD_STEPS - 1,
    );
    expect(effect.events.some((event) => event.type === "nav.arrived")).toBe(
      false,
    );
  });

  it("debounces off-route, recovers, and warns again without warning on one drift sample", () => {
    const start = coord(121);
    const end = coord(121.01);
    const far = coord(122, 26);
    const nav = new NavigationSession();
    nav.armRoute(route([walkLeg([start, end])]));
    nav.start(pos(start));
    expect(
      nav
        .onPosition(pos(far))
        .events.some((event) => event.type === "nav.offroute"),
    ).toBe(false);
    nav.onPosition(pos(far));
    expect(
      nav
        .onPosition(pos(far))
        .events.some((event) => event.type === "nav.offroute"),
    ).toBe(true);
    nav.onPosition(pos(start));
    nav.onPosition(pos(start));
    nav.onPosition(pos(far));
    nav.onPosition(pos(far));
    expect(
      nav
        .onPosition(pos(far))
        .events.some((event) => event.type === "nav.offroute"),
    ).toBe(true);
  });

  it("replays an interrupted whole sentence and merges queue overflow without losing text", () => {
    const start = coord(121);
    const end = coord(121.001);
    const nav = new NavigationSession();
    nav.armRoute(route([walkLeg([start, end])]));
    nav.start(pos(start));
    const first = nav.takeNextSpeech()!;
    for (let i = 0; i < 10; i++) nav.repeatCurrent();
    nav.onInterrupted();
    expect(nav.takeNextSpeech()).toBe(first);
    nav.onTurnComplete();
    const rest: string[] = [];
    let speech: string | null;
    while ((speech = nav.takeNextSpeech())) {
      rest.push(speech);
      nav.onTurnComplete();
    }
    expect(rest.join(" ").split(first).length - 1).toBe(10);
    expect(rest.length).toBeLessThanOrEqual(8);
  });

  it("keeps a terminal geofence when straight fragments are merged", () => {
    const points = [coord(121), coord(121.0005), coord(121.001)];
    const leg = walkLeg(points);
    leg.steps![1].relativeDirection = "CONTINUE";
    leg.steps![2].relativeDirection = "CONTINUE";
    const nav = new NavigationSession();
    nav.armRoute(route([leg]));

    const started = nav.start(pos(points[0]));
    expect(started.events.some((event) => event.type === "nav.arrived")).toBe(
      false,
    );
    const finished = nav.onPosition(pos(points[2]));
    expect(finished.events.some((event) => event.type === "nav.arrived")).toBe(
      true,
    );
  });

  it("keeps active start/stop/cancel idempotent and ignores work after dispose", () => {
    const nav = new NavigationSession();
    nav.armRoute(route([walkLeg([coord(121), coord(121.001)])]));
    nav.start();
    expect(nav.start().events).toEqual([]);
    expect(nav.stop("user_voice").events).toEqual([
      { type: "nav.stop", reason: "user_voice" },
    ]);
    expect(nav.stop("user_voice").events).toEqual([]);
    nav.dispose();
    expect(nav.onPosition(pos(coord(121))).events).toEqual([]);
  });

  it("extracts current transit context and handles proactive transit alerts with deduping", () => {
    const p1 = coord(121);
    const p2 = coord(121.001);
    const p3 = coord(121.002);
    const nav = new NavigationSession();
    nav.armRoute(route([walkLeg([p1, p2]), bus([p2, p3], "台北車站", "西門")]));
    nav.start(pos(p1));

    // Consume the initial start navigation speech
    expect(nav.takeNextSpeech()).not.toBeNull();
    nav.onTurnComplete();

    const ctx = nav.getCurrentTransitAlertContext();
    expect(ctx).toEqual({
      mode: "bus",
      city: "Taipei",
      routeName: "307",
      direction: 0,
      stopName: "台北車站",
      stopUid: undefined,
    });

    const alert1 = {
      alertId: "alert-1",
      title: "307 路線改道通知",
      description: "因施工改道",
      status: 2,
      matchKind: "route" as const,
    };

    const effect1 = nav.onTransitAlerts([alert1]);
    expect(effect1.ok).toBe(true);
    expect(effect1.events).toMatchObject([
      {
        type: "nav.advisory",
        advisories: [
          {
            advisoryId: "transit_alert:alert-1",
            category: "transit_alert",
            title: "307 路線改道通知",
            detail: "因施工改道",
            action: "none",
          },
        ],
      },
    ]);
    expect(nav.takeNextSpeech()).toContain(
      "注意，即時通阻警報：307 路線改道通知",
    );
    nav.onTurnComplete();

    // Repeat same alert should be ignored (deduped)
    const effect2 = nav.onTransitAlerts([alert1]);
    expect(effect2.events).toEqual([]);
    expect(nav.takeNextSpeech()).toBeNull();

    // New alert arrives
    const alert2 = {
      alertId: "alert-2",
      title: "捷運板南線號誌異常",
      description: "班距拉長",
      status: 2,
      matchKind: "line" as const,
    };
    const effect3 = nav.onTransitAlerts([alert1, alert2]);
    expect(effect3.events).toMatchObject([
      {
        type: "nav.advisory",
        advisories: [
          {
            advisoryId: "transit_alert:alert-2",
            category: "transit_alert",
            title: "捷運板南線號誌異常",
            detail: "班距拉長",
            action: "none",
          },
        ],
      },
    ]);
    expect(nav.takeNextSpeech()).toContain(
      "注意，即時通阻警報：捷運板南線號誌異常",
    );
  });
});

describe("NavigationSession road-leg navigation", () => {
  const A = coord(121);
  const B = coord(121.005);
  const P = coord(121.01);
  const W = coord(121.02);
  const M_PER_DEG_LNG = 100_891;
  const M_PER_DEG_LAT = 110_540;
  const shortOf = (
    point: [number, number],
    metres: number,
  ): [number, number] => [point[0] - metres / M_PER_DEG_LNG, point[1]];
  const driftedFrom = (
    point: [number, number],
    metres: number,
  ): [number, number] => [point[0], point[1] + metres / M_PER_DEG_LAT];
  const composite = (): AccessibleRoute =>
    route([driveLeg([A, B, P]), walkLeg([P, W], false)]);
  const drainSpeech = (nav: NavigationSession): string => {
    const spoken: string[] = [];
    for (let next = nav.takeNextSpeech(); next; next = nav.takeNextSpeech()) {
      spoken.push(next);
      nav.onTurnComplete();
    }
    return spoken.join(" ");
  };

  it.each(["DRIVE", "MOTORCYCLE"] as const)(
    "arms, starts and arrives a %s route",
    (type) => {
      const nav = new NavigationSession();
      expect(nav.armRoute(route([driveLeg([A, B, P], type)])).ok).toBe(true);

      const started = nav.start(pos(A));
      expect(started.ok).toBe(true);
      const start = started.events[0];
      expect(start.type).toBe("nav.start");
      if (start.type !== "nav.start") throw new Error("expected nav.start");
      expect(start.steps.map((step) => step.legType)).toEqual(
        start.steps.map(() => type),
      );
      expect(start.steps.some((step) => step.isTransit)).toBe(false);
      expect(started.events.some((event) => event.type === "nav.step")).toBe(
        true,
      );

      nav.onPosition(pos(B));
      const arrival = nav.onPosition(pos(P));
      expect(
        arrival.events.find((event) => event.type === "nav.step"),
      ).toMatchObject({ instruction: "抵達車行路段終點，請停車" });
      expect(arrival.events.map((event) => event.type)).toContain(
        "nav.arrived",
      );
      expect(drainSpeech(nav)).toContain("您已抵達目的地");
    },
  );

  it("opens a 60 m turn geofence on a road leg instead of 30 m", () => {
    const nav = new NavigationSession();
    nav.armRoute(route([driveLeg([A, B, P])]));
    nav.start(pos(A));

    const tooFar = nav.onPosition(pos(shortOf(B, 70)));
    expect(tooFar.events.some((event) => event.type === "nav.step")).toBe(
      false,
    );

    const withinRoadGate = nav.onPosition(pos(shortOf(B, 45)));
    expect(
      withinRoadGate.events.find((event) => event.type === "nav.step"),
    ).toMatchObject({ currentStepIndex: 1 });
  });

  it("tolerates 65 m of road drift but still warns past 80 m", () => {
    const nav = new NavigationSession();
    nav.armRoute(route([driveLeg([A, P])]));
    nav.start(pos(A));

    const tolerated = driftedFrom(coord(121.002), 65);
    for (let i = 0; i < 3; i++) {
      expect(
        nav
          .onPosition(pos(tolerated))
          .events.some((event) => event.type === "nav.offroute"),
      ).toBe(false);
    }

    const beyond = driftedFrom(coord(121.002), 100);
    const samples = [0, 1, 2].map(() =>
      nav
        .onPosition(pos(beyond))
        .events.some((event) => event.type === "nav.offroute"),
    );
    expect(samples).toEqual([false, false, true]);
  });

  it("warns at 50 m on the walking equivalent of the tolerated road drift", () => {
    const nav = new NavigationSession();
    nav.armRoute(route([walkLeg([A, P], false)]));
    nav.start(pos(A));

    const drift = driftedFrom(coord(121.002), 65);
    const samples = [0, 1, 2].map(() =>
      nav
        .onPosition(pos(drift))
        .events.some((event) => event.type === "nav.offroute"),
    );
    expect(samples).toEqual([false, false, true]);
  });

  it("hands a DRIVE leg over to the following WALK leg and restores the 30 m gate", () => {
    const nav = new NavigationSession();
    nav.armRoute(composite());
    nav.start(pos(A));
    nav.onPosition(pos(B));

    const parked = nav.onPosition(pos(P));
    expect(parked.events.map((event) => event.type)).not.toContain(
      "nav.arrived",
    );
    expect(drainSpeech(nav)).toContain("抵達車行路段終點，請停車");

    const roadGateOnly = nav.onPosition(pos(shortOf(W, 45)));
    expect(roadGateOnly.events.some((event) => event.type === "nav.step")).toBe(
      false,
    );

    const walkGate = nav.onPosition(pos(shortOf(W, 20)));
    expect(walkGate.events.map((event) => event.type)).toContain("nav.arrived");
  });

  it("restores the 50 m off-route gate once the WALK leg begins", () => {
    const nav = new NavigationSession();
    nav.armRoute(composite());
    nav.start(pos(A));
    nav.onPosition(pos(B));
    nav.onPosition(pos(P));

    const drift = driftedFrom(coord(121.015), 65);
    const samples = [0, 1, 2].map(() =>
      nav
        .onPosition(pos(drift))
        .events.some((event) => event.type === "nav.offroute"),
    );
    expect(samples).toEqual([false, false, true]);
  });
});

describe("NavigationSession progress and ETA pushes", () => {
  const navigationId = "33333333-3333-4333-8333-333333333333";
  const identified = (base: AccessibleRoute): AccessibleRoute => ({
    ...base,
    navigationId,
    routeVersion: 2,
  });
  const progressOf = (effect: {
    events: { type: string }[];
  }): NavProgressEvent | undefined =>
    effect.events.find((event) => event.type === "nav.progress") as
      NavProgressEvent | undefined;

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports remaining walk distance, duration and a matching arrival stamp", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const start = coord(121);
    const end = coord(121.001);
    const nav = new NavigationSession();
    nav.armRoute(identified(route([walkLeg([start, end])])));

    const atStart = progressOf(nav.start(pos(start)))!;
    expect(NavProgressSchema.parse(atStart)).toEqual(atStart);
    expect(atStart).toMatchObject({
      type: "nav.progress",
      navigationId,
      routeVersion: 2,
      currentStepIndex: 0,
      etaSource: "estimated",
    });
    // 100 m in 2 minutes ≈ 0.83 m/s over the whole remaining leg.
    expect(atStart.remainingDistanceM).toBeGreaterThan(95);
    expect(atStart.remainingDistanceM).toBeLessThan(110);
    expect(atStart.distanceToNextM).toBe(atStart.remainingDistanceM);
    expect(atStart.remainingDurationSec).toBeGreaterThan(110);
    expect(atStart.remainingDurationSec).toBeLessThan(135);
    expect(atStart.estimatedArrivalAt).toBe(
      new Date(
        Date.parse("2026-01-01T00:00:00.000Z") +
          atStart.remainingDurationSec * 1000,
      ).toISOString(),
    );

    const midway = progressOf(nav.onPosition(pos(coord(121.0005))))!;
    expect(midway.remainingDistanceM).toBeLessThan(
      atStart.remainingDistanceM / 1.5,
    );
    expect(midway.remainingDurationSec).toBeLessThan(
      atStart.remainingDurationSec / 1.5,
    );
  });

  it("stays silent for routes carrying no navigation identity", () => {
    const start = coord(121);
    const nav = new NavigationSession();
    nav.armRoute(route([walkLeg([start, coord(121.001)])]));
    expect(progressOf(nav.start(pos(start)))).toBeUndefined();
  });

  it("omits the frame after arrival instead of pushing a post-stop update", () => {
    const start = coord(121);
    const end = coord(121.001);
    const nav = new NavigationSession();
    nav.armRoute(identified(route([walkLeg([start, end])])));
    nav.start(pos(start));
    const arrival = nav.onPosition(pos(end));
    expect(arrival.events.map((event) => event.type)).toEqual([
      "nav.step",
      "nav.arrived",
      "nav.stop",
    ]);
  });

  it("counts the upcoming ride plus its wait, then drops the wait once boarded", () => {
    const p1 = coord(121);
    const p2 = coord(121.001);
    const p3 = coord(121.01);
    const ride = {
      ...metro([p2, p3]),
      waitInfo: { time: 2, source: "schedule" as const },
      estimatedWaitMinutes: undefined,
    };
    const nav = new NavigationSession();
    nav.armRoute(identified(route([walkLeg([p1, p2]), ride])));

    const beforeBoarding = progressOf(nav.start(pos(p1)))!;
    expect(beforeBoarding.etaSource).toBe("schedule");
    // ~100 m walk + ~906 m ride.
    expect(beforeBoarding.remainingDistanceM).toBeGreaterThan(950);
    expect(beforeBoarding.remainingDistanceM).toBeLessThan(1060);
    // ~121 s walk + 180 s ride + 120 s wait.
    expect(beforeBoarding.remainingDurationSec).toBeGreaterThan(390);
    expect(beforeBoarding.remainingDurationSec).toBeLessThan(450);

    nav.onPosition(pos(p2));
    const boarded = progressOf(nav.onPosition(pos(p2)))!;
    expect(boarded.currentStepIndex).toBeGreaterThan(
      beforeBoarding.currentStepIndex,
    );
    expect(boarded.remainingDistanceM).toBeGreaterThan(850);
    expect(boarded.remainingDistanceM).toBeLessThan(960);
    expect(boarded.remainingDurationSec).toBeGreaterThan(150);
    expect(boarded.remainingDurationSec).toBeLessThan(215);
  });

  it("prefers a realtime wait source over the scheduled one", () => {
    const p1 = coord(121);
    const p2 = coord(121.001);
    const nav = new NavigationSession();
    nav.armRoute(
      identified(
        route([
          walkLeg([p1, p2]),
          {
            ...metro([p2, coord(121.01)]),
            waitInfo: { time: 3, source: "realtime" as const },
          },
        ]),
      ),
    );
    expect(progressOf(nav.start(pos(p1)))!.etaSource).toBe("realtime");
  });

  it("switches etaSource to estimated after alighting and entering the final walk leg", () => {
    const p1 = coord(121);
    const p2 = coord(121.001);
    const p3 = coord(121.01);
    const p4 = coord(121.011);
    const ride = {
      ...metro([p2, p3]),
      waitInfo: { time: 2, source: "schedule" as const },
      estimatedWaitMinutes: undefined,
    };
    const nav = new NavigationSession();
    nav.armRoute(
      identified(route([walkLeg([p1, p2]), ride, walkLeg([p3, p4])])),
    );

    const atStart = progressOf(nav.start(pos(p1)))!;
    expect(atStart.etaSource).toBe("schedule");

    // Reach boarding station and board
    nav.onPosition(pos(p2));
    const boarded = progressOf(nav.onPosition(pos(p2)))!;
    expect(boarded.etaSource).toBe("schedule");

    // Reach alight station (triggering transit_alight)
    const alighted = progressOf(nav.onPosition(pos(p3)))!;
    expect(alighted.etaSource).toBe("estimated");

    // Continuing on final walking leg
    const walkingFinal = progressOf(nav.onPosition(pos(coord(121.0105))))!;
    expect(walkingFinal.etaSource).toBe("estimated");
  });

  it("calculates wait duration when waitInfo.time is an HH:MM string and updates dynamically as time passes", () => {
    vi.useFakeTimers();
    try {
      // Fix current time at 10:00:00
      const baseTime = new Date(2026, 8, 2, 10, 0, 0);
      vi.setSystemTime(baseTime);

      const p1 = coord(121);
      const p2 = coord(121.001);
      const p3 = coord(121.01);
      // Scheduled departure at 10:10
      const ride = {
        ...metro([p2, p3]),
        waitInfo: { time: "10:10", source: "schedule" as const },
        estimatedWaitMinutes: undefined,
      };
      const nav = new NavigationSession();
      nav.armRoute(identified(route([walkLeg([p1, p2]), ride])));

      const atStart = progressOf(nav.start(pos(p1)));
      expect(atStart).toBeDefined();
      expect(atStart?.etaSource).toBe("schedule");
      const initialWaitAndRide = atStart?.remainingDurationSec ?? 0;
      // At 10:00:00, wait to 10:10 is 600s
      expect(initialWaitAndRide).toBeGreaterThanOrEqual(600);

      // Advance time by 300 seconds (5 minutes to 10:05:00) without moving position
      vi.advanceTimersByTime(300 * 1000);
      const after5Min = progressOf(nav.onPosition(pos(p1)));
      expect(after5Min).toBeDefined();
      // Remaining duration should decrease by ~300 seconds
      expect(after5Min?.remainingDurationSec).toBe(initialWaitAndRide - 300);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports free_flow while a road leg remains and estimated once parked", () => {
    const A = coord(121);
    const B = coord(121.005);
    const P = coord(121.01);
    const W = coord(121.02);
    const nav = new NavigationSession();
    nav.armRoute(
      identified(route([driveLeg([A, B, P]), walkLeg([P, W], false)])),
    );

    const atStart = progressOf(nav.start(pos(A)))!;
    expect(NavProgressSchema.parse(atStart)).toEqual(atStart);
    expect(atStart.etaSource).toBe("free_flow");

    expect(progressOf(nav.onPosition(pos(B)))!.etaSource).toBe("free_flow");
    expect(progressOf(nav.onPosition(pos(P)))!.etaSource).toBe("estimated");
  });

  it("drives road ETAs from the leg duration, else 40/35 km/h defaults", () => {
    const A = coord(121);
    const B = coord(121.005);
    const P = coord(121.01);
    const durationOf = (type: "DRIVE" | "MOTORCYCLE", durationMin: number) => {
      const nav = new NavigationSession();
      nav.armRoute(
        identified(route([driveLeg([A, B, P], type, { durationMin })])),
      );
      return progressOf(nav.start(pos(A)))!;
    };

    // ~1009 m of geometry at the 11.1 m/s and 9.7 m/s free-flow fallbacks.
    const drive = durationOf("DRIVE", 0);
    expect(drive.remainingDistanceM).toBeGreaterThan(1000);
    expect(drive.remainingDistanceM).toBeLessThan(1020);
    expect(drive.remainingDurationSec).toBeGreaterThan(88);
    expect(drive.remainingDurationSec).toBeLessThan(94);

    const motorcycle = durationOf("MOTORCYCLE", 0);
    expect(motorcycle.remainingDurationSec).toBeGreaterThan(101);
    expect(motorcycle.remainingDurationSec).toBeLessThan(107);

    // 1000 m / 5 min = 3.33 m/s from the leg's own estimate, not the default.
    const timetabled = durationOf("DRIVE", 5);
    expect(timetabled.remainingDurationSec).toBeGreaterThan(295);
    expect(timetabled.remainingDurationSec).toBeLessThan(310);
  });

  it("falls back to estimated when transit waitInfo source is unavailable or carries no schedule", () => {
    const p1 = coord(121);
    const p2 = coord(121.001);
    const p3 = coord(121.01);
    const ride = {
      ...metro([p2, p3]),
      waitInfo: { time: null, source: "unavailable" as const },
      estimatedWaitMinutes: undefined,
    };
    const nav = new NavigationSession();
    nav.armRoute(identified(route([walkLeg([p1, p2]), ride])));

    const atStart = progressOf(nav.start(pos(p1)))!;
    expect(atStart.etaSource).toBe("estimated");
  });
});

describe("navigation geometry uses [lng, lat]", () => {
  it("calculates haversine and nearest polyline distance in metres", () => {
    expect(haversineLngLat([121, 25], [121.001, 25])).toBeGreaterThan(90);
    expect(haversineLngLat([121, 25], [121.001, 25])).toBeLessThan(120);
    expect(
      distanceToPolylineM(
        [121.0005, 25],
        [
          [121, 25],
          [121.001, 25],
        ],
      ),
    ).toBeLessThan(1);
  });
});

describe("NavigationSession resume from snapshot", () => {
  const navigationId = "44444444-4444-4444-8444-444444444444";
  const identified = (base: AccessibleRoute): AccessibleRoute => ({
    ...base,
    navigationId,
    routeVersion: 3,
  });
  const snapshotOf = (
    overrides: Partial<NavigationSessionSnapshot> = {},
  ): NavigationSessionSnapshot => ({
    navigationId,
    userId: "user-1",
    routeToken: "token",
    routeVersion: 3,
    currentStepIndex: 1,
    onVehicle: false,
    latestPosition: null,
    updatedAt: Date.now(),
    ...overrides,
  });

  const points: [number, number][] = [
    coord(121),
    coord(121.001),
    coord(121.002),
  ];

  it("emits nav.resume_ok carrying the snapshot correlation and full step list", () => {
    const nav = new NavigationSession();
    const effect = nav.resume(
      identified(route([walkLeg(points)])),
      snapshotOf(),
    );
    expect(effect.ok).toBe(true);
    const resumed = effect.events.find((e) => e.type === "nav.resume_ok");
    expect(resumed).toMatchObject({
      navigationId,
      routeVersion: 3,
      routeToken: "token",
      currentStepIndex: 1,
      onVehicle: false,
    });
    expect(NavResumeOkMessageSchema.parse(resumed)).toEqual(resumed);
    expect(
      (resumed as { steps: unknown[] }).steps.length,
    ).toBeGreaterThanOrEqual(2);
    expect(nav.getSnapshotState()).toEqual({
      currentStepIndex: 1,
      onVehicle: false,
    });
  });

  it("does not replay already-announced steps", () => {
    const nav = new NavigationSession();
    const effect = nav.resume(
      identified(route([walkLeg(points)])),
      snapshotOf({ currentStepIndex: 1 }),
    );
    expect(effect.events.some((e) => e.type === "nav.start")).toBe(false);
    expect(effect.events.some((e) => e.type === "nav.step")).toBe(false);
  });

  it("clamps a snapshot index past the rebuilt step list", () => {
    const nav = new NavigationSession();
    const effect = nav.resume(
      identified(route([walkLeg(points)])),
      snapshotOf({ currentStepIndex: 999 }),
    );
    const resumed = effect.events.find((e) => e.type === "nav.resume_ok") as {
      currentStepIndex: number;
      totalSteps: number;
    };
    expect(resumed.currentStepIndex).toBe(resumed.totalSteps - 1);
  });

  it("restores the on-vehicle flag from the snapshot", () => {
    const nav = new NavigationSession();
    nav.resume(
      identified(route([bus(points)])),
      snapshotOf({ onVehicle: true }),
    );
    expect(nav.getSnapshotState()?.onVehicle).toBe(true);
  });

  it("advances from the supplied position and pushes progress", () => {
    const nav = new NavigationSession();
    const effect = nav.resume(
      identified(route([walkLeg(points)])),
      snapshotOf({ currentStepIndex: 0 }),
      pos(points[1]),
    );
    const progress = effect.events.find((e) => e.type === "nav.progress");
    expect(progress).toMatchObject({ navigationId, routeVersion: 3 });
    expect(NavProgressSchema.parse(progress)).toEqual(progress);
    expect(nav.getSnapshotState()!.currentStepIndex).toBeGreaterThan(0);
  });

  it("accepts positions and reports conversation context after resuming", () => {
    const nav = new NavigationSession();
    nav.resume(identified(route([walkLeg(points)])), snapshotOf());
    expect(nav.getConversationContext().active).toBe(true);
    expect(nav.onPosition(pos(points[1])).ok).toBe(true);
  });

  it("rejects an empty route and a disposed session", () => {
    expect(new NavigationSession().resume(route([]), snapshotOf()).ok).toBe(
      false,
    );
    const disposed = new NavigationSession();
    disposed.dispose();
    const effect = disposed.resume(
      identified(route([walkLeg(points)])),
      snapshotOf(),
    );
    expect(effect.ok).toBe(false);
    expect(effect.events).toEqual([]);
  });

  it("reports no snapshot state before resuming or after stopping", () => {
    const nav = new NavigationSession();
    expect(nav.getSnapshotState()).toBeNull();
    nav.resume(identified(route([walkLeg(points)])), snapshotOf());
    nav.stop("user_ui");
    expect(nav.getSnapshotState()).toBeNull();
  });
});

describe("navigation-session domain purity", () => {
  it("does not import transport or Gemini sessions", async () => {
    const source = await import("fs/promises").then((fs) =>
      fs.readFile(
        // `import.meta.url` is unavailable under the repo's commonjs target;
        // resolve the sibling file from the compiled module's location instead.
        new URL(`file://${__dirname}/navigation-session.ts`),
        "utf8",
      ),
    );
    expect(source).not.toMatch(/from ["']ws["']/);
    expect(source).not.toContain("@google/genai");
    expect(source).not.toMatch(/import[^;]+\bSession\b/);
  });
});
