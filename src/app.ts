import express, { Express, NextFunction, Request, Response } from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import cookieParser from "cookie-parser";
import { apiReference } from "@scalar/express-api-reference";
import type { ApiResponse } from "./types/response";
import { ResponseCode } from "./types/code";
import { sendResponse } from "./config/lib";
import { ERROR_MESSAGE } from "./constants/messages";
import middleware from "./middleware/middleware";
import { createA11yRouter } from "./modules/a11y";
import { createAccessibleRouteRouter } from "./modules/accessible-route";
import { createNavInstructionsRouter } from "./modules/nav-instructions";
import { createPlaceSearchRouter } from "./modules/place-search";
import { createTransitRouter } from "./modules/transit";
import { createUserRouter } from "./modules/user";
import { createAirRouter } from "./modules/air";
import { createAiRouter } from "./modules/ai";
import { createHazardReportRouter } from "./modules/hazard-report";
import { createEnvironmentRouter } from "./modules/environment";
import { createWelfareRouter } from "./modules/welfare";
import { createVisualA11yRouter } from "./modules/visual-a11y";
import { createReviewRouter } from "./modules/review";
import { createCampusRouter } from "./modules/campus";
import { createEmergencyContactRouter } from "./modules/emergency-contact";
import { createSosRouter } from "./modules/sos";
import { createLineRouter } from "./modules/line";
import { createVoiceRouter } from "./modules/voice";
import { generateOpenAPIDocument } from "./openapi/document";

const app: Express = express();

// Number of reverse proxies in front of the app. Rate limiters key on req.ip,
// so leaving this unset makes every request share the proxy's IP and one bucket.
// It must stay a hop count rather than `true`, otherwise a client can spoof
// X-Forwarded-For to get a fresh bucket per request.
app.set("trust proxy", Number(process.env.TRUST_PROXY_HOPS ?? 1));

app.use(
  helmet({
    contentSecurityPolicy: false,
  }),
);

const corsOrigins = process.env.CORS_ORIGINS?.split(",")
  .map((o) => o.trim())
  .filter(Boolean) ?? ["http://localhost:3000"];
app.use(cors({ origin: corsOrigins, credentials: true }));

app.use(morgan("common"));
app.use(cookieParser());

// LINE webhook is the one exception that must mount BEFORE express.json():
// its HMAC-SHA256 signature is verified over the raw, unparsed body, so the
// router uses express.raw() internally instead of the global JSON parser.
app.use("/api/v1/line", createLineRouter());

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

app.get("/health", (_req: Request, res: Response) => {
  res.status(ResponseCode.OK).json({
    status: "OK",
    message: "Server is running",
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/v1/openapi.json", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "application/json");
  res.send(generateOpenAPIDocument());
});

app.use(
  "/docs",
  apiReference({
    url: "/api/v1/openapi.json",
    theme: "default",
  }),
);

app.use("/api/v1/user", middleware, createUserRouter());
app.use("/api/v1/user", middleware, createEmergencyContactRouter());
app.use("/api/v1/sos", createSosRouter());
app.use("/api/v1/transit", createTransitRouter());
app.use("/api/v1/a11y", createA11yRouter());
app.use("/api/v1/a11y", createAccessibleRouteRouter());
app.use("/api/v1/a11y", createNavInstructionsRouter());
app.use("/api/v1/a11y", createHazardReportRouter());
app.use("/api/v1/a11y", createEnvironmentRouter());
app.use("/api/v1/a11y", createWelfareRouter());
app.use("/api/v1/a11y", createVisualA11yRouter());
app.use("/api/v1/a11y", createReviewRouter());
app.use("/api/v1/a11y", createCampusRouter());
app.use("/api/v1/a11y", createPlaceSearchRouter());
app.use("/api/v1/air", createAirRouter());
app.use("/api/v1/ai", createAiRouter());

if (process.env.VOICE_POC_ENABLED === "true") {
  app.use("/api/v1/voice", createVoiceRouter());
}

app.use("*", (req: Request, res: Response<ApiResponse<null>>) => {
  sendResponse(
    res,
    false,
    "error",
    ResponseCode.NOT_FOUND,
    `Method ${req.method} ${req.originalUrl} not found`,
  );
});

const CLIENT_ERROR_CODES = new Set<number>([
  ResponseCode.INVALID_INPUT,
  ResponseCode.UNAUTHORIZED,
  ResponseCode.FORBIDDEN,
  ResponseCode.NOT_FOUND,
  ResponseCode.CONFLICT,
  ResponseCode.GONE,
  ResponseCode.TOO_MANY_REQUESTS,
]);

/**
 * Classifies an uncaught error into an envelope status and message.
 *
 * Framework-level errors — a malformed JSON body, an oversized payload — carry
 * an HTTP status and set `expose` when their own message is safe to return.
 * Express's default handler honours both, so ignoring them would report a
 * client's mistake as a server fault. A 4xx outside `ResponseCode` degrades to
 * 400 rather than 500, because it is still not our fault.
 *
 * @param err The error raised upstream in the chain.
 * @returns The status code and message to answer with.
 */
function classifyError(err: unknown): { code: ResponseCode; message: string } {
  const candidate = err as {
    status?: unknown;
    statusCode?: unknown;
    message?: unknown;
    expose?: unknown;
  };
  const status =
    typeof candidate.status === "number" ? candidate.status : candidate.statusCode;

  if (typeof status !== "number" || status < 400 || status > 499) {
    return { code: ResponseCode.INTERNAL_ERROR, message: ERROR_MESSAGE.INTERNAL };
  }

  const exposed =
    candidate.expose === true &&
    typeof candidate.message === "string" &&
    candidate.message.length > 0;

  return {
    code: CLIENT_ERROR_CODES.has(status)
      ? (status as ResponseCode)
      : ResponseCode.INVALID_INPUT,
    message: exposed ? (candidate.message as string) : ERROR_MESSAGE.BAD_REQUEST,
  };
}

/**
 * Terminal error handler, so an uncaught error answers with the standard
 * envelope instead of Express's default HTML page — which breaks every client
 * that parses JSON, and leaks a stack trace outside production.
 *
 * Errors raised after the response has started (the SSE and streaming routes)
 * are delegated to Express, which destroys the connection: nothing can be
 * prepended to bytes already on the wire.
 *
 * @param err The error raised upstream in the chain.
 * @param _req Express request.
 * @param res Express response.
 * @param next Express next handler, used only for the headers-sent case.
 */
app.use(
  (
    err: unknown,
    _req: Request,
    res: Response<ApiResponse<null>>,
    next: NextFunction,
  ) => {
    const { code, message } = classifyError(err);

    if (code === ResponseCode.INTERNAL_ERROR) {
      console.error("[app] unhandled error:", err);
    }

    if (res.headersSent) return next(err);
    sendResponse(res, false, "error", code, message);
  },
);

export default app;
