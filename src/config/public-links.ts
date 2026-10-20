/**
 * Public web links handed to LINE users carry high-entropy capabilities,
 * never enumerable Mongo ObjectIds.
 *
 * The tracking path `/zh-TW/sos/` is also claimed by the mobile app
 * (Universal Links / App Links), so a contact with the app installed lands in
 * the app and everyone else gets the web tracker. The tracking token rides in
 * the URL fragment, which browsers never send to a server, so it stays out of CDN /
 * server logs and `Referer` headers.
 */
const DEFAULT_LOCALE = "zh-TW";

function trimBase(value: string | undefined): string {
  return (value ?? "").trim().replace(/\/$/, "");
}

/**
 * @param shareToken The session's public share token.
 * @returns The public live-location tracking URL (token in the fragment).
 */
export function sosTrackingUrl(shareToken: string): string {
  const base = trimBase(process.env.PUBLIC_TRACKING_BASE_URL);
  return `${base}/${DEFAULT_LOCALE}/sos/#token=${encodeURIComponent(shareToken)}`;
}

/**
 * @param shareToken The SOS session's public share token, when known.
 * @param planToken The cached general route plan's capability, when known.
 * @returns The web route-preview URL, or undefined when no base is configured.
 */
export function routePreviewUrl(
  shareToken?: string,
  planToken?: string,
): string | undefined {
  const base =
    trimBase(process.env.PUBLIC_LIFF_ROUTE_BASE_URL) ||
    (trimBase(process.env.PUBLIC_TRACKING_BASE_URL)
      ? `${trimBase(process.env.PUBLIC_TRACKING_BASE_URL)}/${DEFAULT_LOCALE}/`
      : "");
  if (!base) return undefined;
  try {
    const url = new URL(base);
    url.searchParams.delete("sessionId");
    url.searchParams.delete("planToken");
    if (shareToken) url.searchParams.set("sessionId", shareToken);
    else if (planToken) url.searchParams.set("planToken", planToken);
    return url.toString();
  } catch {
    return undefined;
  }
}

/**
 * LINE opens links in its in-app browser, where Universal Links / App Links
 * never fire. `openExternalBrowser=1` hands the URL to the OS, which opens the
 * app when installed and the default browser otherwise.
 *
 * @param url An absolute https URL.
 * @returns The URL with LINE's external-browser flag, or the input if unparsable.
 */
export function forLineExternalOpen(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("openExternalBrowser", "1");
    return parsed.toString();
  } catch {
    return url;
  }
}
