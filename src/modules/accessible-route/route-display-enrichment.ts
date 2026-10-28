import type {
  AccessibleRoute,
  WalkLeg,
  BusLeg,
  MetroLeg,
  ThsrLeg,
  TraLeg,
} from "../../types/route";
import type { SupportedLang } from "../../types/lang";
import { selectDisplayText } from "../../utils/source-display";
import {
  copyWithDescriptors,
  presentStreetNames,
} from "../../utils/route-source-names";
import {
  lookupRouteNameSources,
  trainNameKey,
  type RouteNameKeys,
} from "./route-display-enrichment.repository";

/** Presentation only, after all matching/ranking/overlays, before token capture. */
export async function enrichRouteDisplayNames(
  routes: AccessibleRoute[],
  language?: SupportedLang,
): Promise<AccessibleRoute[]> {
  if (language === undefined) return routes;
  const keys: RouteNameKeys = {
    busStops: [],
    busRoutes: [],
    metroStations: [],
    trainStations: [],
  };
  for (const route of routes)
    for (const leg of route.legs) {
      if (leg.type === "BUS") {
        keys.busStops.push(
          ...[
            leg.departureStopId,
            leg.arrivalStopId,
            ...(leg.intermediateStops ?? []).map((s) => s.stationUid),
          ].filter((id): id is string => !!id),
        );
        if (leg.subRouteUid) keys.busRoutes.push(leg.subRouteUid);
      } else if (leg.type === "METRO") {
        keys.metroStations.push(
          leg.departureStationUid,
          leg.arrivalStationUid,
          leg.terminalStationUid ?? "",
          ...(leg.intermediateStops ?? []).flatMap((s) =>
            s.stationUid ? [s.stationUid] : [],
          ),
        );
      } else if (leg.type === "TRA" || leg.type === "THSR") {
        keys.trainStations.push(
          ...[
            leg.departureStationUID,
            leg.arrivalStationUID,
            ...(leg.intermediateStops ?? []).flatMap((s) =>
              s.stationUid ? [s.stationUid] : [],
            ),
          ]
            .filter(Boolean)
            .map((id) => ({ railSystem: leg.type, id })),
        );
      }
    }
  keys.busStops = [...new Set(keys.busStops)];
  keys.busRoutes = [...new Set(keys.busRoutes)];
  keys.metroStations = [...new Set(keys.metroStations.filter(Boolean))];
  keys.trainStations = [
    ...new Map(
      keys.trainStations.map((key) => [
        trainNameKey(key.railSystem, key.id),
        key,
      ]),
    ).values(),
  ];
  const sources = await lookupRouteNameSources(keys);
  function facility<
    T extends {
      name?: string;
      tags?: Record<string, string>;
      displayName?: string;
    },
  >(f: T): T {
    const displayName = selectDisplayText(
      f.name ?? "",
      f.tags?.["name:en"],
      language,
    );
    const copy = { ...f };
    if (displayName.trim()) copy.displayName = displayName;
    else delete copy.displayName;
    return copy;
  }
  return routes.map((route) => {
    const legs = route.legs.map((rawLeg) => {
      if (rawLeg.type === "DRIVE" || rawLeg.type === "MOTORCYCLE")
        return rawLeg;
      const leg = rawLeg as WalkLeg | BusLeg | MetroLeg | ThsrLeg | TraLeg;
      let from: string, to: string, routeName: string | undefined;
      let fromEn = leg.fromNameEn,
        toEn = leg.toNameEn,
        routeEn = leg.routeNameEn;
      const sourceFor = (id?: string): string | undefined => {
        if (!id) return undefined;
        if (leg.type === "BUS") return sources.busStops.get(id);
        if (leg.type === "METRO") return sources.metroStations.get(id);
        if (leg.type === "TRA" || leg.type === "THSR")
          return sources.trainStations.get(trainNameKey(leg.type, id));
        return undefined;
      };
      if (leg.type === "WALK") {
        from = leg.from;
        to = leg.to;
      } else if (leg.type === "BUS") {
        from = leg.departureStop;
        to = leg.arrivalStop;
        routeName = leg.routeName;
        fromEn = sourceFor(leg.departureStopId) ?? fromEn;
        toEn = sourceFor(leg.arrivalStopId) ?? toEn;
        routeEn = sources.busRoutes.get(leg.subRouteUid) ?? routeEn;
      } else {
        from = leg.departureStation;
        to = leg.arrivalStation;
        fromEn =
          sourceFor(
            leg.type === "METRO"
              ? leg.departureStationUid
              : leg.departureStationUID,
          ) ?? fromEn;
        toEn =
          sourceFor(
            leg.type === "METRO"
              ? leg.arrivalStationUid
              : leg.arrivalStationUID,
          ) ?? toEn;
        routeName =
          leg.type === "METRO"
            ? leg.lineName
            : leg.type === "TRA"
              ? leg.trainTypeName
              : undefined;
      }
      const copy = copyWithDescriptors(leg, {
        ...(fromEn?.trim() ? { fromNameEn: fromEn.trim() } : {}),
        ...(toEn?.trim() ? { toNameEn: toEn.trim() } : {}),
        ...(routeEn?.trim() ? { routeNameEn: routeEn.trim() } : {}),
        fromDisplayName: selectDisplayText(from, fromEn, language),
        toDisplayName: selectDisplayText(to, toEn, language),
        ...(routeName !== undefined
          ? {
              routeDisplayName: selectDisplayText(routeName, routeEn, language),
            }
          : {}),
      });
      if (copy.type === "METRO" && copy.terminalStation) {
        const terminalEn =
          sourceFor(copy.terminalStationUid)?.trim() ||
          copy.terminalNameEn?.trim();
        if (terminalEn) copy.terminalNameEn = terminalEn;
        copy.terminalDisplayName = selectDisplayText(
          copy.terminalStation,
          terminalEn,
          language,
        );
      }
      if (copy.type === "WALK") {
        if (copy.stepStreetNames)
          copy.stepStreetNames = presentStreetNames(copy as WalkLeg, language);
        copy.a11yFacilities = copy.a11yFacilities.map(facility);
      } else {
        if (copy.intermediateStops)
          copy.intermediateStops = copy.intermediateStops.map((stop) => {
            const en = sourceFor(stop.stationUid) ?? stop.nameEn;
            return {
              ...stop,
              ...(en?.trim() ? { nameEn: en.trim() } : {}),
              displayName: selectDisplayText(stop.name, en, language),
            };
          });
        if (copy.type === "BUS") {
          copy.departureStopA11y = copy.departureStopA11y.map(facility);
          copy.arrivalStopA11y = copy.arrivalStopA11y.map(facility);
        } else {
          copy.departureStationA11y = copy.departureStationA11y.map(facility);
          copy.arrivalStationA11y = copy.arrivalStationA11y.map(facility);
        }
      }
      return copy;
    });
    return copyWithDescriptors(route, {
      legs,
      ...(route.facilities
        ? {
            facilities: Object.fromEntries(
              Object.entries(route.facilities).map(([id, f]) => [
                id,
                facility(f),
              ]),
            ),
          }
        : {}),
    });
  });
}
