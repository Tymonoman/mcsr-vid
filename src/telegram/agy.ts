/**
 * agy as the report's brain: the reasoner CLI (src/shorts/reasoner.ts, `config.reasonerCommand`)
 * answers one JSON object — a headline and a to-do list — over the deterministic FACTS `facts.ts`
 * gathers. Numbers are never agy's to invent: the prompt tells it to copy them from FACTS, and
 * everything it returns is validated before it reaches a Telegram message; junk falls back to a
 * rule-based to-do list, never a stall.
 */
import { reasonerConfigured, runReasoner } from "../shorts/reasoner.js";

export interface AgyAnswer {
  /** At most two lines. */
  headline: string;
  /** Ordered by what matters most; at most 8. */
  todo: string[];
  /** Anomalies agy noticed in the facts; at most 3. */
  notes?: string[];
}

const MAX_TODO = 8;
const MAX_NOTES = 3;
/** A generous cap on one line — long enough for a real to-do item, short enough to catch a model
 *  that pasted something it should not have (a comment's text, a stack trace). */
const MAX_LINE_CHARS = 300;

/** Strips control characters (not `\n`) and trims; null for anything not a usable string. */
function cleanLine(s: unknown): string | null {
  if (typeof s !== "string") return null;
  // eslint-disable-next-line no-control-regex -- deliberately stripping control bytes
  const t = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();
  return t && t.length <= MAX_LINE_CHARS ? t : null;
}

/**
 * Holds agy's answer to the contract: a two-line-or-shorter headline, a non-empty to-do list of
 * plain strings (bad items are dropped, not rejected whole — a model that added one over-length
 * item should not cost the other seven), optional notes the same way. Anything else is null, the
 * caller's cue to fall back.
 */
export function validateAgyAnswer(raw: unknown): AgyAnswer | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const headline = cleanLine(o.headline);
  if (!headline || headline.split("\n").length > 2) return null;
  if (!Array.isArray(o.todo)) return null;
  const todo = o.todo
    .map(cleanLine)
    .filter((x): x is string => x !== null)
    .slice(0, MAX_TODO);
  if (todo.length === 0) return null;
  const answer: AgyAnswer = { headline, todo };
  if (o.notes !== undefined) {
    if (!Array.isArray(o.notes)) return null;
    const notes = o.notes
      .map(cleanLine)
      .filter((x): x is string => x !== null)
      .slice(0, MAX_NOTES);
    if (notes.length) answer.notes = notes;
  }
  return answer;
}

export const AGY_ANSWER_SCHEMA = {
  type: "object",
  properties: {
    headline: { type: "string" },
    todo: { type: "array", items: { type: "string" }, maxItems: MAX_TODO },
    notes: { type: "array", items: { type: "string" }, maxItems: MAX_NOTES },
  },
  required: ["headline", "todo"],
  additionalProperties: false,
} as const;

export interface AgyResult {
  source: "agy" | "fallback";
  answer: AgyAnswer;
  /** Why it fell back, when it did. */
  note?: string;
}

/**
 * Flash sometimes reaches for a shell command, which headless mode denies, and the run then ends
 * with nothing (the Short picker sees it too, src/shorts/videoPick.ts). So every prompt says no
 * tools, and a refused or empty run is asked once more before the fallback stands in.
 */
const NO_TOOLS =
  "Do not use any tools, files or commands: everything you need is in this message. Answer directly.";

async function askOnce(prompt: string, schema: object, timeoutMs: number) {
  const run = () => runReasoner(`${NO_TOOLS}\n\n${prompt}`, { schema, timeoutMs });
  const first = await run();
  return first.ok || !/denied|answered nothing/i.test(first.error) ? first : run();
}

/** How long an agy ask waits before the rule-based to-do stands in: Flash at high effort on the whole
 *  facts sheet took 47 s once and over 120 s the next time; at 07:00 nobody is waiting on it. */
export const AGY_REPORT_TIMEOUT_MS = 300_000;

/**
 * Asks agy the morning report's question. `fallback` is called only when agy is not configured,
 * fails, times out, or answers junk — never speculatively, since it may itself be a few lines of
 * work (reading `.dashboard.json`, tallying the queue).
 */
export async function askAgyForReport(
  prompt: string,
  fallback: () => AgyAnswer,
  timeoutMs = AGY_REPORT_TIMEOUT_MS,
): Promise<AgyResult> {
  if (!reasonerConfigured())
    return { source: "fallback", answer: fallback(), note: "reasonerCommand is not set" };
  const reply = await askOnce(prompt, AGY_ANSWER_SCHEMA, timeoutMs);
  if (!reply.ok) return { source: "fallback", answer: fallback(), note: reply.error };
  const answer = validateAgyAnswer(reply.answer);
  if (!answer)
    return { source: "fallback", answer: fallback(), note: "answered, but not a usable to-do list" };
  return { source: "agy", answer };
}

const ASK_SCHEMA = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
} as const;

export type AgyFreeform = { ok: true; text: string } | { ok: false; reason: string };

/**
 * `/ask <question>`: agy answers one question from a fresh facts snapshot, as plain text. Routed
 * through the same JSON-schema mechanism as the report (`{ "answer": "…" }`) rather than parsing
 * free prose out of the CLI's own envelope, which is what `runReasoner` is built to do reliably.
 */
export async function askAgyFreeform(
  prompt: string,
  timeoutMs = AGY_REPORT_TIMEOUT_MS,
): Promise<AgyFreeform> {
  if (!reasonerConfigured()) return { ok: false, reason: "reasonerCommand is not set" };
  const reply = await askOnce(prompt, ASK_SCHEMA, timeoutMs);
  if (!reply.ok) return { ok: false, reason: reply.error };
  const raw = (reply.answer as Record<string, unknown>).answer;
  // eslint-disable-next-line no-control-regex -- deliberately stripping control bytes
  const text =
    typeof raw === "string" ? raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim() : "";
  return text
    ? { ok: true, text: text.slice(0, 3500) }
    : { ok: false, reason: "answered, but with no usable text" };
}
