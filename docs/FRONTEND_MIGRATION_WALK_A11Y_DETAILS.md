# Frontend migration — B12 WALK accessibility details

**Affected endpoint:** `POST /api/v1/a11y/accessible-route`
**Affected legs:** every `type: "WALK"` leg, including transit access walks,
walk-only routes, and drive/motorcycle walk connectors (including the marked
Valhalla pedestrian fallback).
**Compatibility:** additive response fields; all six fields below are now
present on every WALK leg.

```ts
type WalkA11yDetails = {
  maxSlopePercent: number | null;
  crossings: number | null;
  crossingsWithCurbRamp: number | null;
  minPathWidthCm: number | null;
  surfaceType: "paved" | "gravel" | "unknown";
  restPoints: Array<{
    type: "accessible_toilet";
    distanceM: number;
  }>;
};
```

## Required UI behaviour

Render `null` and `"unknown"` as **unknown / unavailable**, never as zero,
flat, wide, paved, or safe. In the current production data, WALK
`a11yFacilities` are normally empty and OSM incline coverage is sparse, so the
usual honest shape is:

```json
{
  "maxSlopePercent": null,
  "crossings": null,
  "crossingsWithCurbRamp": null,
  "minPathWidthCm": null,
  "surfaceType": "unknown",
  "restPoints": []
}
```

`restPoints: []` means no already-attached, explicitly accessible OSM toilet
could be surfaced for this leg. It is **not** a claim that no toilet exists.

## Source and measurement semantics

- No new per-leg database or external lookup is made for these fields.
- Numeric values are derived only from OSM tags already attached to the WALK
  leg. Missing tags remain `null`; an untagged crossing kerb is not counted as
  a missing ramp.
- `crossings` and `crossingsWithCurbRamp` are observed tagged features, not a
  complete survey of every crossing on the geometry.
- `surfaceType` is `unknown` when no usable surface tag exists or available
  tags conflict; the backend does not assume a surface from the routing engine.
- `restPoints[].distanceM` is rounded route progress from the WALK start to the
  closest point on the routed polyline. It is not a door-to-door or detour
  distance.

## Compact responses

With `format: "compact"`, `a11yFacilities` may be emptied and represented by
`a11yRefs` plus route-level `facilities`. The B12 WALK detail fields remain
directly on the WALK leg and retain the exact values shown before compaction.
