import { GoogleGenAI } from "@google/genai";

const googleGenAi = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: process.env.GEMINI_API_URL
    ? { baseUrl: process.env.GEMINI_API_URL }
    : undefined,
});

const model = process.env.GEMINI_MODEL || "gemini-3.7-flash";

/**
 * @returns Upper bound for one webSearch tool call. A voice turn is blocked
 *   until every tool in it responds, so an unbounded search stalls the reply.
 */
function getWebSearchTimeoutMs(): number {
  const raw = process.env.WEB_SEARCH_TIMEOUT_MS;
  if (raw == null || raw.trim() === "") return 15_000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid WEB_SEARCH_TIMEOUT_MS: expected a positive number of milliseconds, got "${raw}"`,
    );
  }
  return parsed;
}

export { googleGenAi, model, getWebSearchTimeoutMs };
