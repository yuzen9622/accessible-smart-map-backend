import type { Request, Response } from "express";
import { sendResponse } from "../../config/lib";
import { ResponseCode } from "../../types/code";
import * as service from "./review.service";
import type {
  CreateReviewInput,
  UpdateReviewInput,
  ReviewQueryParams,
  ReviewSummaryInput,
  ServiceResult,
} from "./review.types";

function send(res: Response, result: ServiceResult) {
  return sendResponse(
    res,
    result.ok,
    result.ok ? "success" : "error",
    result.httpCode as ResponseCode,
    result.message,
    result.data,
  );
}

export async function createReview(req: Request, res: Response) {
  const body = req.validated?.body as CreateReviewInput;
  const result = await service.createReview(req.auth!.userId, body);
  return send(res, result);
}

export async function listReviews(req: Request, res: Response) {
  const query = req.validated?.query as ReviewQueryParams;
  const result = await service.findByPlace(query);
  return send(res, result);
}

export async function updateReview(req: Request, res: Response) {
  const params = req.validated?.params as { id: string };
  const body = req.validated?.body as UpdateReviewInput;
  const result = await service.updateReview(params.id, req.auth!.userId, body);
  return send(res, result);
}

export async function deleteReview(req: Request, res: Response) {
  const params = req.validated?.params as { id: string };
  const result = await service.deleteReview(params.id, req.auth!.userId);
  return send(res, result);
}

export async function getAiSummary(req: Request, res: Response) {
  const query = req.validated?.query as ReviewSummaryInput;
  const result = await service.getAiSummary(query.placeId, query.placeType);
  return send(res, result);
}
