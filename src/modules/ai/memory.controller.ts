import type { Request, Response } from "express";
import { sendResponse } from "../../config/lib";
import { MEMORY_MSG, ERROR_MESSAGE } from "../../constants/messages";
import { ResponseCode, ResponseMessage } from "../../types/code";
import type {
  MemoryCategory,
  MemorySensitivity,
  UpdateMemoryInput,
} from "./memory.service";
import {
  clearMemories,
  deleteMemory,
  getMemorySettings,
  listMemories,
  saveMemory,
  updateMemory,
  updateMemorySettings,
} from "./memory.service";

function getUserId(req: Request, res: Response): string | null {
  const userId = req.auth?.userId;
  if (!userId) {
    sendResponse(
      res,
      false,
      "error",
      ResponseCode.UNAUTHORIZED,
      ResponseMessage.UNAUTHORIZED,
    );
    return null;
  }
  return userId;
}

function toMemoryDto(memory: {
  _id: string;
  content: string;
  category: MemoryCategory;
  sensitivity: MemorySensitivity;
  source: string;
  createdAt: Date;
  updatedAt: Date;
  expiresAt?: Date;
}) {
  return {
    id: String(memory._id),
    content: memory.content,
    category: memory.category,
    sensitivity: memory.sensitivity,
    source: memory.source,
    createdAt: memory.createdAt?.toISOString?.() ?? String(memory.createdAt),
    updatedAt: memory.updatedAt?.toISOString?.() ?? String(memory.updatedAt),
    expiresAt: memory.expiresAt ? memory.expiresAt.toISOString() : null,
  };
}

export async function listUserMemories(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const userId = getUserId(req, res);
    if (!userId) return;
    const { limit } = req.query as { limit?: number };
    const memories = await listMemories(userId, limit ?? 100);
    sendResponse(res, true, "success", ResponseCode.OK, MEMORY_MSG.LIST_OK, {
      memories: memories.map(toMemoryDto),
    });
  } catch (error) {
    console.error("[memory/list]", error);
    sendResponse(
      res,
      false,
      "error",
      ResponseCode.INTERNAL_ERROR,
      ERROR_MESSAGE.INTERNAL,
    );
  }
}

export async function createUserMemory(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const userId = getUserId(req, res);
    if (!userId) return;
    const body = req.body as {
      content: string;
      category: MemoryCategory;
      sensitivity?: MemorySensitivity;
      expiresAt?: string;
    };
    const memory = await saveMemory(userId, body.content, body.category, {
      source: "explicit_user",
      sensitivity: body.sensitivity,
      requireMemoryEnabled: false,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
    });
    sendResponse(
      res,
      true,
      "success",
      ResponseCode.CREATED,
      MEMORY_MSG.CREATED,
      {
        memory: toMemoryDto(memory),
      },
    );
  } catch (error) {
    console.error("[memory/create]", error);
    sendResponse(
      res,
      false,
      "error",
      ResponseCode.INTERNAL_ERROR,
      ERROR_MESSAGE.INTERNAL,
    );
  }
}

export async function updateUserMemory(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const userId = getUserId(req, res);
    if (!userId) return;
    const { id } = req.params as { id: string };
    const body = req.body as {
      content?: string;
      category?: MemoryCategory;
      sensitivity?: MemorySensitivity;
      expiresAt?: string | null;
    };
    const input: UpdateMemoryInput = {
      content: body.content,
      category: body.category,
      sensitivity: body.sensitivity,
      expiresAt:
        body.expiresAt === undefined
          ? undefined
          : body.expiresAt === null
            ? null
            : new Date(body.expiresAt),
    };
    const memory = await updateMemory(userId, id, input);
    if (!memory) {
      sendResponse(
        res,
        false,
        "error",
        ResponseCode.NOT_FOUND,
        MEMORY_MSG.NOT_FOUND,
      );
      return;
    }
    sendResponse(res, true, "success", ResponseCode.OK, MEMORY_MSG.UPDATED, {
      memory: toMemoryDto(memory),
    });
  } catch (error) {
    console.error("[memory/update]", error);
    sendResponse(
      res,
      false,
      "error",
      ResponseCode.INTERNAL_ERROR,
      ERROR_MESSAGE.INTERNAL,
    );
  }
}

export async function deleteUserMemory(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const userId = getUserId(req, res);
    if (!userId) return;
    const { id } = req.params as { id: string };
    const deleted = await deleteMemory(userId, id);
    if (!deleted) {
      sendResponse(
        res,
        false,
        "error",
        ResponseCode.NOT_FOUND,
        MEMORY_MSG.NOT_FOUND,
      );
      return;
    }
    sendResponse(res, true, "success", ResponseCode.OK, MEMORY_MSG.DELETED, {
      deleted: true,
    });
  } catch (error) {
    console.error("[memory/delete]", error);
    sendResponse(
      res,
      false,
      "error",
      ResponseCode.INTERNAL_ERROR,
      ERROR_MESSAGE.INTERNAL,
    );
  }
}

export async function clearUserMemories(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const userId = getUserId(req, res);
    if (!userId) return;
    const deletedCount = await clearMemories(userId);
    sendResponse(res, true, "success", ResponseCode.OK, MEMORY_MSG.CLEARED, {
      deletedCount,
    });
  } catch (error) {
    console.error("[memory/clear]", error);
    sendResponse(
      res,
      false,
      "error",
      ResponseCode.INTERNAL_ERROR,
      ERROR_MESSAGE.INTERNAL,
    );
  }
}

export async function getUserMemorySettings(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const userId = getUserId(req, res);
    if (!userId) return;
    const settings = await getMemorySettings(userId);
    sendResponse(
      res,
      true,
      "success",
      ResponseCode.OK,
      MEMORY_MSG.SETTINGS_OK,
      settings,
    );
  } catch (error) {
    console.error("[memory/settings:get]", error);
    sendResponse(
      res,
      false,
      "error",
      ResponseCode.INTERNAL_ERROR,
      ERROR_MESSAGE.INTERNAL,
    );
  }
}

export async function updateUserMemorySettings(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const { memoryEnabled } = req.body as { memoryEnabled: boolean };
    const userId = getUserId(req, res);
    if (!userId) return;
    const settings = await updateMemorySettings(userId, {
      memoryEnabled,
    });
    sendResponse(
      res,
      true,
      "success",
      ResponseCode.OK,
      MEMORY_MSG.SETTINGS_UPDATED,
      settings,
    );
  } catch (error) {
    console.error("[memory/settings:update]", error);
    sendResponse(
      res,
      false,
      "error",
      ResponseCode.INTERNAL_ERROR,
      ERROR_MESSAGE.INTERNAL,
    );
  }
}
