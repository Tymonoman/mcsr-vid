/**
 * Claude's reports are Markdown; Telegram's HTML mode renders the same things, so a report sent
 * with `npm run tg -- send --md <file>` reads as it did in the chat instead of showing raw
 * asterisks (the operator, 29 Sept 2026: "incorporate markdown ... for better formatting").
 * Headings and **bold** → bold, `code` and fences → code, [t](u) → links, "- " → "•", and a
 * | table | → an aligned monospace block (Telegram has no tables).
 */
import { escapeHtml, splitMessage } from "./bot.js";

/** Bold, links, code and italics inside one line; code spans are kept out of everything else. */
function inline(text: string): string {
  const codes: string[] = [];
  const s = escapeHtml(text.replace(/`([^`]+)`/g, (_, c: string) => `\u0000${codes.push(c) - 1}\u0000`))
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      (_, t: string, u: string) => `<a href="${u.replace(/"/g, "&quot;")}">${t}</a>`,
    )
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,:;!?]|$)/g, "$1<i>$2</i>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, n: string) => `<code>${escapeHtml(codes[Number(n)]!)}</code>`);
}

/** A table cell for a monospace block: the text, without the Markdown around it. */
const plainCell = (c: string): string =>
  c
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*|`/g, "")
    .trim();

export function mdToTelegramHtml(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) {
      const body: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]!); i++) body.push(lines[i]!);
      out.push(`<pre>${escapeHtml(body.join("\n"))}</pre>`);
      continue;
    }
    if (/^\s*\|/.test(line)) {
      const rows: string[][] = [];
      for (; i < lines.length && /^\s*\|/.test(lines[i]!); i++) {
        if (/^\s*\|[\s:|-]+\|\s*$/.test(lines[i]!)) continue; // the |---|---| rule
        rows.push(
          lines[i]!.trim()
            .replace(/^\||\|$/g, "")
            .split("|")
            .map(plainCell),
        );
      }
      i--;
      const widths = rows[0]!.map((_, c) => Math.max(...rows.map((r) => (r[c] ?? "").length)));
      const text = rows
        .map((r) =>
          r
            .map((c, k) => c.padEnd(widths[k] ?? 0))
            .join("  ")
            .trimEnd(),
        )
        .join("\n");
      out.push(`<pre>${escapeHtml(text)}</pre>`);
      continue;
    }
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      out.push(`<b>${inline(heading[1]!)}</b>`);
      continue;
    }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    out.push(bullet ? `${bullet[1]}• ${inline(bullet[2]!)}` : inline(line));
  }
  return out.join("\n");
}

/**
 * Markdown in pieces of at most `max` characters, cut between paragraphs and never inside a code
 * fence, so each piece converts to HTML on its own; a paragraph longer than `max` is cut hard.
 */
export function chunkMarkdown(md: string, max = 3000): string[] {
  const paras: string[] = [];
  let cur: string[] = [];
  let fence = false;
  for (const line of md.split("\n")) {
    if (/^\s*```/.test(line)) fence = !fence;
    if (!fence && line.trim() === "" && cur.length) {
      paras.push(cur.join("\n"));
      cur = [];
    } else if (fence || line.trim() !== "") cur.push(line);
  }
  if (cur.length) paras.push(cur.join("\n"));
  const chunks: string[] = [];
  let acc = "";
  for (const p of paras.flatMap((p) => splitMessage(p, max))) {
    if (acc && acc.length + 2 + p.length > max) {
      chunks.push(acc);
      acc = "";
    }
    acc = acc ? `${acc}\n\n${p}` : p;
  }
  if (acc) chunks.push(acc);
  return chunks;
}
