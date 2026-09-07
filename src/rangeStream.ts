import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Serving a video file over HTTP the way a `<video>` element needs it.
 *
 * The existing download route pipes the whole file and sets no `Accept-Ranges`, which is correct
 * for "save this" and useless for "play this": without range support the browser cannot seek at
 * all, and dragging the scrubber re-downloads from zero. A finished match export is ~800 MB, so
 * that is not a small difference.
 */

export type ParsedRange =
  { kind: "none" } | { kind: "range"; start: number; end: number } | { kind: "unsatisfiable" };

/**
 * Parses one byte range. Only a single range is honoured: multipart ranges need a
 * multipart/byteranges body, no browser media element asks for them, and answering with the
 * whole file is a legal response to a range we choose not to satisfy.
 *
 * `end` is inclusive, matching the header and `createReadStream`.
 */
export function parseRange(header: string | undefined, size: number): ParsedRange {
  if (header === undefined) return { kind: "none" };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return { kind: "none" };

  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return { kind: "none" };

  // An empty size has no satisfiable range at all, and the arithmetic below would underflow.
  if (size === 0) return { kind: "unsatisfiable" };

  if (rawStart === "") {
    // Suffix form: the last N bytes. More than the file is the whole file, not an error.
    const suffix = Number(rawEnd);
    if (suffix === 0) return { kind: "unsatisfiable" };
    return { kind: "range", start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(rawStart);
  if (start >= size) return { kind: "unsatisfiable" };
  // An absent or over-long end means "to the end of the file".
  const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (end < start) return { kind: "unsatisfiable" };
  return { kind: "range", start, end };
}

/**
 * Streams a file with range support, inline so the browser plays it rather than downloading it.
 * Answers HEAD as well: media elements probe with one before deciding how to fetch.
 */
export async function sendVideo(
  req: IncomingMessage,
  res: ServerResponse,
  filePath: string,
  filename: string,
): Promise<void> {
  const { size } = await stat(filePath);
  const parsed = parseRange(req.headers.range, size);

  const base = {
    "content-type": "video/mp4",
    "accept-ranges": "bytes",
    "content-disposition": `inline; filename="${filename}"`,
    // The file is rewritten in place by a re-export under the same name, so a cached copy would
    // be a previous render.
    "cache-control": "no-store",
  };

  if (parsed.kind === "unsatisfiable") {
    res.writeHead(416, { ...base, "content-range": `bytes */${size}` });
    res.end();
    return;
  }

  const [status, start, end] = parsed.kind === "range" ? [206, parsed.start, parsed.end] : [200, 0, size - 1];

  res.writeHead(status, {
    ...base,
    "content-length": String(end - start + 1),
    ...(status === 206 ? { "content-range": `bytes ${start}-${end}/${size}` } : {}),
  });

  if (req.method === "HEAD") {
    res.end();
    return;
  }

  const stream = createReadStream(filePath, { start, end });
  // A viewer seeking mid-stream aborts the response; without this the read stream is left open
  // holding a descriptor on an 800 MB file, once per seek.
  res.on("close", () => stream.destroy());
  stream.on("error", () => res.destroyed || res.end());
  stream.pipe(res);
}
