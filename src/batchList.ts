import { readFile } from "node:fs/promises";

/** One match URL/ID per line; blank lines and `#` comments are skipped. */
export function parseBatchList(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

export async function readBatchList(filePath: string): Promise<string[]> {
  return parseBatchList(await readFile(filePath, "utf8"));
}
