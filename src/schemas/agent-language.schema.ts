import { z } from "zod";

/** Language codes currently exposed by the Web and mobile language settings. */
export const AgentLanguageSchema = z.enum(["zh-TW", "en"]);
