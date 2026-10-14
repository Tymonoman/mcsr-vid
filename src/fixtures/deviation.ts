import assert from "node:assert/strict";

/** Doc vs code: keep the doc's assertion, report the gap, keep going (triage decides). */
export async function deviation(clause: string, check: () => void | Promise<void>): Promise<void> {
  try {
    await check();
  } catch (err) {
    if (!(err instanceof assert.AssertionError)) throw err;
    console.log(`DEVIATION: ${clause} — ${err.message.split("\n")[0]}`);
  }
}
