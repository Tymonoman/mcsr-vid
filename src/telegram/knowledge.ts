import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** `handbook/knowledge/`: the channel's reports, in the repo because the dashboard container cannot see `~/.claude`. */
const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "handbook", "knowledge");

/** Sent to Claude over stdin, not argv, so there is no ~128 KiB cap to budget against; 70 KB
 *  still keeps `/ask` answering quickly and leaves room for FACTS and the question. */
export const KNOWLEDGE_BUDGET = 70_000;

const STOP = new Set(
  "the and for are was were what which who whom how why when where does did can could should would will our you your this that these those with from about have has had not but all any into out too very just than then them they their there here more most some such only also".split(
    " ",
  ),
);

const words = (s: string): string[] =>
  (s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])
    .filter((w) => !STOP.has(w))
    .map((w) => w.replace(/s$/, ""));

const bytes = (s: string) => Buffer.byteLength(s);

/**
 * What Claude is told besides FACTS: `channel.md` whole, an index of every doc, and the `## ` sections
 * that share the most words with the question (a heading match counts triple), best first until
 * the budget is spent, then put back in reading order. A plain substring match, so "earning" finds
 * "earn". ponytail: keyword scoring, no embeddings — swap in a retriever if the docs outgrow this.
 */
export function knowledgeFor(question: string, budget = KNOWLEDGE_BUDGET, dir = DIR): string {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort();
  const read = (f: string) => fs.readFileSync(path.join(dir, f), "utf8");
  const title = (t: string) => t.match(/^# (.+)$/m)?.[1] ?? "";

  const brief = files.includes("channel.md") ? `### channel.md\n${read("channel.md")}` : "";
  const others = files.filter((f) => f !== "channel.md");
  const index = others.map((f) => `- ${f}: ${title(read(f))}`).join("\n");
  const head = [brief, `### Every document (sections below are picked for the question)\n${index}`].join(
    "\n\n",
  );

  const q = words(question);
  const chunks = others.flatMap((f, doc) =>
    read(f)
      .split(/^(?=## )/m)
      .map((text, i) => {
        const heading = (text.match(/^#{1,2} (.+)$/m)?.[1] ?? "").toLowerCase();
        const body = text.toLowerCase();
        const score = q.reduce((n, w) => n + (body.includes(w) ? 1 : 0) + (heading.includes(w) ? 3 : 0), 0);
        return { doc, i, score, text: `### ${f}\n${text.trim()}` };
      }),
  );

  let left = budget - bytes(head);
  const picked = chunks
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || a.doc - b.doc || a.i - b.i)
    .filter((c) => {
      const n = bytes(c.text) + 2;
      if (n > left) return false;
      left -= n;
      return true;
    })
    .sort((a, b) => a.doc - b.doc || a.i - b.i);

  return [head, ...picked.map((c) => c.text)].join("\n\n");
}
