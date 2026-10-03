import { z } from "zod";

/** Shared HTTP, AI intent and tool boundary contract; omission stays undefined. */
export const TransitPreferenceSchema = z.enum(["none", "bus", "rail"]);
