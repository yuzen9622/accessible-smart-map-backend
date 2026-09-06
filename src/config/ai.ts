import { GoogleGenAI } from "@google/genai";

const googleGenAi = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: process.env.GEMINI_API_URL
    ? { baseUrl: process.env.GEMINI_API_URL }
    : undefined,
});

const model = process.env.GEMINI_MODEL || "gemini-3.7-flash";

export { googleGenAi, model };
