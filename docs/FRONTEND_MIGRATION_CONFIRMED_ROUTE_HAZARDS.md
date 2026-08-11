# Frontend migration — confirmed route hazards

`POST /api/v1/a11y/accessible-route` now may add `route.hazardAdvisory`. This is
additive; clients that do not use it keep the existing route contract.

```ts
hazardAdvisory?: {
  onRoute: Array<{
    id: string;
    hazardType: "obstacle" | "construction" | "data_error";
    severity: "blocking" | "difficult" | "minor";
    description?: string;
    location: { lat: number; lng: number };
    distanceM: number;
  }>;
  avoided: Array<same hazard shape>;
  blockingOnRoute: number;
  penaltyPoints: number;
};
```

- `onRoute` contains only still-active reports that are `verified`, have at
  least one community confirmation, and are within the server's small
  ground-geometry corridor.
- `avoided` is deliberately stronger than a generic recommendation: it appears
  **only** on the selected route when the same verified hazard intersects at
  least one alternative candidate but not that selected route. Do not infer an
  avoidance claim from an empty array, a single candidate, or a missing field.
- Matching uses only `WALK`, `DRIVE`, and `MOTORCYCLE` route geometry. Transit
  line/station approximations are not proof that a street-level obstacle affects
  the trip.
- A missing `hazardAdvisory` means the server had no safe, complete matching
  result (for example the bounded query, geometry, or candidate coverage was
  unavailable). It does **not** mean that no hazard exists.
- When all fully matched alternatives are affected, the selected least-harmful
  route has `degraded: true` and `warnings` includes the named all-candidates
  hazard warning. Render both the warning and the machine-readable `onRoute`
  details; do not present it as a successful avoidance.
