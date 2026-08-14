import type { Request, Response } from "express";
import type { ServiceCoverageConfig } from "../../config/coverage";
import { sendResponse } from "../../config/lib";
import type { ApiResponse } from "../../types/response";
import { ResponseCode } from "../../types/code";
import { MSG, ERROR_MESSAGE } from "../../constants/messages";
import * as a11yService from "./a11y.service";
import type { A11yCategory, A11yFacility } from "./a11y.service";

async function getAllFacilities(
	req: Request,
	res: Response<ApiResponse<A11yFacility[]>>,
) {
	try {
		const { category } = (req.validated?.query ?? {}) as {
			category?: A11yCategory[];
		};
		const data = await a11yService.findAllFacilities(category);
		return sendResponse(res, true, "success", ResponseCode.OK, MSG.OK, data);
	} catch {
		return sendResponse(
			res,
			false,
			"error",
			ResponseCode.INTERNAL_ERROR,
			ERROR_MESSAGE.INTERNAL,
		);
	}
}

function getServiceCoverage(
	_req: Request,
	res: Response<ApiResponse<ServiceCoverageConfig>>,
) {
	try {
		const data = a11yService.getServiceCoverage();
		return sendResponse(res, true, "success", ResponseCode.OK, MSG.OK, data);
	} catch {
		return sendResponse(
			res,
			false,
			"error",
			ResponseCode.INTERNAL_ERROR,
			ERROR_MESSAGE.INTERNAL,
		);
	}
}

async function getBathrooms(
	req: Request,
	res: Response<ApiResponse<A11yFacility[]>>,
) {
	try {
		const data = await a11yService.findBathroomFacilities();
		return sendResponse(res, true, "success", ResponseCode.OK, MSG.OK, data);
	} catch {
		return sendResponse(
			res,
			false,
			"error",
			ResponseCode.INTERNAL_ERROR,
			ERROR_MESSAGE.INTERNAL,
		);
	}
}

async function getRamps(
	req: Request,
	res: Response<ApiResponse<A11yFacility[]>>,
) {
	try {
		const data = await a11yService.findRampFacilities();
		return sendResponse(res, true, "success", ResponseCode.OK, MSG.OK, data);
	} catch {
		return sendResponse(
			res,
			false,
			"error",
			ResponseCode.INTERNAL_ERROR,
			ERROR_MESSAGE.INTERNAL,
		);
	}
}

async function getElevators(
	req: Request,
	res: Response<ApiResponse<A11yFacility[]>>,
) {
	try {
		const data = await a11yService.findElevatorFacilities();
		return sendResponse(res, true, "success", ResponseCode.OK, MSG.OK, data);
	} catch {
		return sendResponse(
			res,
			false,
			"error",
			ResponseCode.INTERNAL_ERROR,
			ERROR_MESSAGE.INTERNAL,
		);
	}
}

async function getA11yPlace(req: Request, res: Response<ApiResponse<any>>) {
	try {
		const raw = String(req.query.osmId ?? "");
		const ids = raw
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
		if (!ids.length) {
			return sendResponse(
				res,
				false,
				"error",
				ResponseCode.INVALID_INPUT,
				`${ERROR_MESSAGE.MISSING_PARAMS}：osmId`,
			);
		}
		const places = await a11yService.findByOsmIds(ids);
		if (!places.length) {
			return sendResponse(
				res,
				false,
				"error",
				ResponseCode.NOT_FOUND,
				"查無此設施",
			);
		}
		return sendResponse(res, true, "success", ResponseCode.OK, MSG.OK, places);
	} catch (error) {
		return sendResponse(
			res,
			false,
			"error",
			ResponseCode.INTERNAL_ERROR,
			(error as string) || ERROR_MESSAGE.INTERNAL,
		);
	}
}

async function nearbyA11y(req: Request, res: Response<ApiResponse<any>>) {
	try {
		const { lat, lng } = req.query;
		const result = await a11yService.findNearby(
			Number(lat as string),
			Number(lng as string),
		);
		return sendResponse(res, true, "success", ResponseCode.OK, MSG.OK, result);
	} catch (error) {
		return sendResponse(
			res,
			false,
			"error",
			ResponseCode.INTERNAL_ERROR,
			(error as string) || ERROR_MESSAGE.INTERNAL,
		);
	}
}

async function nearbyParking(req: Request, res: Response<ApiResponse<any>>) {
	try {
		const { lat, lng, radius, type } = (req.validated?.query ?? {}) as {
			lat: string;
			lng: string;
			radius?: string;
			type?: a11yService.ParkingKind | "all";
		};
		const result = await a11yService.findNearbyParking(
			Number(lat),
			Number(lng),
			radius != null ? Number(radius) : undefined,
			type,
		);
		return sendResponse(res, true, "success", ResponseCode.OK, MSG.OK, result);
	} catch (error) {
		return sendResponse(
			res,
			false,
			"error",
			ResponseCode.INTERNAL_ERROR,
			(error as string) || ERROR_MESSAGE.INTERNAL,
		);
	}
}

async function quickAssess(req: Request, res: Response<ApiResponse<any>>) {
	try {
		const { lat, lng, mode, radius } = (req.validated?.query ?? {}) as {
			lat: string;
			lng: string;
			mode?: a11yService.QuickAssessMode;
			radius?: string;
		};
		const result = await a11yService.assessQuickAccess({
			lat: Number(lat),
			lng: Number(lng),
			mode,
			radiusM: radius != null ? Number(radius) : undefined,
		});
		return sendResponse(res, true, "success", ResponseCode.OK, MSG.OK, result);
	} catch (error) {
		return sendResponse(
			res,
			false,
			"error",
			ResponseCode.INTERNAL_ERROR,
			(error as string) || ERROR_MESSAGE.INTERNAL,
		);
	}
}

export {
	getAllFacilities,
	getServiceCoverage,
	getBathrooms,
	getRamps,
	getElevators,
	nearbyA11y,
	nearbyParking,
	getA11yPlace,
	quickAssess,
};
