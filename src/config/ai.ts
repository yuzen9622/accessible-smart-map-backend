import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";

const googleGenAi = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: process.env.GEMINI_API_URL
    ? { baseUrl: process.env.GEMINI_API_URL }
    : undefined,
});

const openai = new OpenAI({
  apiKey: process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY,
  baseURL:
    process.env.GEMINI_API_URL ||
    "https://generativelanguage.googleapis.com/v1beta/openai",
});

const model = process.env.GEMINI_MODEL || "gemini-3-flash-preview";

export { googleGenAi, openai, model };
