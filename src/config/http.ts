// cloudflared keeps idle origin connections for 90 s, so the server must keep
// them longer or a request can land on a socket it just closed. The facility
// list only changes on data imports, and metro outage notices are cached 5 min
// upstream, so a minute of reuse adds little staleness.
export const HTTP_CONFIG = {
  /** How long an idle keep-alive socket stays open before the server closes it. */
  keepAliveTimeoutMs: 95_000,
  /** How long a built `GET /a11y/all-facilities` body is reused. */
  facilityListCacheTtlMs: 60_000,
} as const;
