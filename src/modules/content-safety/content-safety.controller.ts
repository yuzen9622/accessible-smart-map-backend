import type { Request, Response } from "express";
import { sendResponse } from "../../config/lib";
import type { ResponseCode } from "../../types/code";
import * as service from "./content-safety.service";
import type {
  DecisionInput,
  ReportInput,
  TargetInput,
} from "./content-safety.schema";

function identity(req: Request): string {
  if (!req.auth) throw new Error("Authenticated identity required");
  return req.auth.userId;
}

function send(
  res: Response,
  result: Awaited<ReturnType<typeof service.reportContent>>,
) {
  res.setHeader("Cache-Control", "private, no-store");
  return sendResponse(
    res,
    result.ok,
    result.ok ? "success" : "error",
    result.httpCode as ResponseCode,
    result.message,
    result.data,
  );
}
export async function report(req: Request, res: Response) {
  return send(
    res,
    await service.reportContent(
      identity(req),
      req.validated?.body as ReportInput,
    ),
  );
}
export async function block(req: Request, res: Response) {
  return send(
    res,
    await service.blockContentAuthor(
      identity(req),
      req.validated?.body as TargetInput,
    ),
  );
}
export async function blocks(req: Request, res: Response) {
  return send(res, await service.getBlocks(identity(req)));
}
export async function unblock(req: Request, res: Response) {
  return send(
    res,
    await service.unblock(identity(req), req.params.id as string),
  );
}
export async function getCase(req: Request, res: Response) {
  return send(res, await service.getCase(req.params.id as string));
}
export async function decide(req: Request, res: Response) {
  return send(
    res,
    await service.decide(
      req.params.id as string,
      identity(req),
      req.validated?.body as DecisionInput,
    ),
  );
}

export async function listCases(req: Request, res: Response) {
  return send(
    res,
    await service.listCases(
      (req.validated?.query as { cursor?: string }).cursor,
    ),
  );
}
