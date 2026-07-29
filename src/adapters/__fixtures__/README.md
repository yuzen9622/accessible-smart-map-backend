# Rail fixtures

Test fixtures for `rail.parse` / `rail.adapter`.

## `rail-station-timetables.json`

Real, de-identified TDX v2 station daily-timetable payloads for TRA and THSR,
used to pin the station-timetable parsing contract to real data.

- **Source endpoints** (recorded in the file's `sourceTra` / `sourceThsr`):
  `.../v2/Rail/{TRA,THSR}/DailyTimetable/Station/1000/<date>` (臺北).
- **Captured**: see `capturedAt` in the file. Regenerate with
  `pnpm capture:rail-fixtures` (needs `.env` TDX credentials).
- **Shape**: both systems return a **top-level array of flat train rows**
  (`TrainNo`, `Direction`, `TrainTypeName.Zh_tw`, `EndingStationName.Zh_tw`,
  `ArrivalTime`, `DepartureTime` — times are `HH:mm`). Wrapper shape, field
  names and value types are preserved verbatim.
- **De-identification**: train arrays are capped to 30 rows to keep the fixture
  small; nothing else is rewritten. Rail timetables contain no personal data.

## `od-crossmidnight.synthetic.json`

**Synthetic** (hand-authored, NOT captured) minimal OD payload with a
cross-midnight train (23:50 → 00:40) plus one same-day train, used to test the
`arrivesNextDay` / cross-midnight duration logic in `parseOdBody`. Cross-midnight
is OD trip semantics and does not appear on a single-station board, so it cannot
be captured from the station endpoint.
