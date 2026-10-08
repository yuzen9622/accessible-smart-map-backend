import type { Request, RequestHandler } from "express";
import morgan from "morgan";

const UNMATCHED_ROUTE = "<unmatched>";

/**
 * The matched route template (e.g. `/api/v1/sos/sessions/:token/public`),
 * never the concrete URL: query strings carry coordinates and path params
 * carry share tokens, and neither may reach the ops logs.
 *
 * @param req The finished request
 * @returns Mount path + route pattern, or `<unmatched>` when no route matched
 */
export function routeTemplate(req: Request): string {
  const routePath = req.route?.path;
  if (typeof routePath !== "string") return UNMATCHED_ROUTE;
  return `${req.baseUrl ?? ""}${routePath}`;
}

morgan.token("route", (req) => routeTemplate(req as Request));

const ACCESS_LOG_FORMAT =
  ":remote-addr - [:date[clf]] :method :route :status :res[content-length] - :response-time ms";

/**
 * HTTP access logger that records the route template instead of the URL.
 *
 * @param stream Output sink (defaults to stdout)
 * @returns Express middleware
 */
export function createAccessLogger(stream?: {
  write: (line: string) => void;
}): RequestHandler {
  return morgan(ACCESS_LOG_FORMAT, stream ? { stream } : undefined);
}
