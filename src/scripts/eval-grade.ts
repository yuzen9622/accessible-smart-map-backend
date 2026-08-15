import type { GenerateContentResponse } from "@google/genai";

export interface ToolCall {
  name: string;
  args: any;
}

export interface ArgGradeCase {
  expectTool: string;
  expectArgs?: (args: any, ctx: { today: string }) => string | null;
}

/**
 * Extract tool calls (name + args) from a Gemini response. Calls without a
 * name are ignored; missing args default to {}.
 *
 * @param raw The raw Gemini response (or undefined).
 * @returns The extracted tool calls.
 */
export function extractCalls(
  raw: GenerateContentResponse | undefined,
): ToolCall[] {
  const calls = raw?.functionCalls ?? [];
  const out: ToolCall[] = [];
  for (const c of calls) {
    if (typeof c?.name === "string" && c.name) {
      out.push({ name: c.name, args: c.args ?? {} });
    }
  }
  return out;
}

/**
 * Grade the arguments of the expected tool's first call. Does NOT judge tool
 * selection (that stays with the name grader): when there is no `expectArgs`,
 * the case is `__none__`, or the expected tool did not fire, it passes.
 *
 * @param calls The extracted tool calls.
 * @param c The case's expected tool and optional arg predicate.
 * @param ctx Context passed to the predicate (today's Taipei date).
 * @returns Whether the args pass, with a reason on failure.
 */
export function gradeArgs(
  calls: ToolCall[],
  c: ArgGradeCase,
  ctx: { today: string },
): { pass: boolean; reason?: string } {
  if (!c.expectArgs || c.expectTool === "__none__") return { pass: true };
  const hit = calls.find((call) => call.name === c.expectTool);
  if (!hit) return { pass: true };
  const reason = c.expectArgs(hit.args, ctx);
  return reason ? { pass: false, reason } : { pass: true };
}
