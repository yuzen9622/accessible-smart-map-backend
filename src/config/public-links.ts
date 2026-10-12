/**
 * Public web links handed to LINE users. Each carries the SOS session's
 * high-entropy share token — never the enumerable Mongo ObjectId.
 *
 * The tracking path `/zh-TW/sos/?token=` is also claimed by the mobile app
 * (Universal Links / App Links), so a contact with the app installed lands in
 * the app and everyone else gets the web tracker.
 */
const DEFAULT_LOCALE = "zh-TW";

function trimBase(value: string | undefined): string {
  return (value ?? "").trim().replace(/\/$/, "");
}

/**
 * @param shareToken The session's public share token.
 * @returns The public live-location tracking URL.
 */
export function sosTrackingUrl(shareToken: string): string {
  const base = trimBase(process.env.PUBLIC_TRACKING_BASE_URL);
  return `${base}/${DEFAULT_LOCALE}/sos/?token=${encodeURIComponent(shareToken)}`;
}

/**
 * @param shareToken The session's public share token, when known.
 * @returns The web route-preview URL, or undefined when no base is configured.
 */
export function routePreviewUrl(shareToken?: string): string | undefined {
  const base =
    trimBase(process.env.PUBLIC_LIFF_ROUTE_BASE_URL) ||
    (trimBase(process.env.PUBLIC_TRACKING_BASE_URL)
      ? `${trimBase(process.env.PUBLIC_TRACKING_BASE_URL)}/${DEFAULT_LOCALE}/`
      : "");
  if (!base) return undefined;
  try {
    const url = new URL(base);
    if (shareToken) url.searchParams.set("sessionId", shareToken);
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
