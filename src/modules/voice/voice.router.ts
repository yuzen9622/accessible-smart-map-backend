import path from "path";
import { Router, Request, Response } from "express";

/**
 * Creates the voice module router. Currently serves only the browser POC
 * test page.
 *
 * @returns The configured Express router.
 */
export function createVoiceRouter(): Router {
  const router = Router();

  router.get("/poc", (_req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, "poc-client.html"));
  });

  return router;
}
