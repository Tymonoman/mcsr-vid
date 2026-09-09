// Self-check for reasoner.ts. Every way the command can misbehave must come back as null, and
// never as a throw: the callers are a render and a dashboard route with a heuristic of their
// own. The commands are `node -e` stand-ins, so no CLI and no network are needed.
// Run: npx tsx src/reasoner.test.ts
import assert from "node:assert/strict";
import { askReasoner, firstJsonObject, reasonerPrompt } from "./reasoner.js";

const nodeE = (script: string, ...rest: string[]) => ["node", "-e", script, ...rest];
/** A command that reads the prompt from stdin and answers inside Antigravity's envelope. */
const envelope = nodeE(
  `let s="";process.stdin.on("data",c=>s+=c).on("end",()=>console.log(JSON.stringify({status:"SUCCESS",response:"Sure. "+JSON.stringify({pick:1,gotTask:s.includes("choose the cut")})+" done"})))`,
);

// --- The happy path: envelope unwrapped, the object dug out of the prose around it, the prompt
// delivered on stdin when no argument carries it.
assert.deepEqual(await askReasoner("choose the cut", { a: 1 }, { command: envelope }), {
  pick: 1,
  gotTask: true,
});

// --- `{prompt}` in the argv is replaced by the prompt. Echoing the argument back makes the first
// object in the output the input itself, which proves the substitution end to end.
assert.deepEqual(
  await askReasoner("echo", { marker: 42 }, { command: nodeE("console.log(process.argv[1])", "{prompt}") }),
  { marker: 42 },
);

// --- Every failure is null, not a throw.
for (const [label, command, opts] of [
  ["not configured", null, {}],
  ["garbage output", nodeE('console.log("nope")'), {}],
  ["exit 1", nodeE("process.exit(1)"), {}],
  ["missing binary", ["definitely-not-a-binary-mcsr"], {}],
  ["timeout", nodeE("setTimeout(()=>{}, 5000)"), { timeoutMs: 200 }],
] as const) {
  const started = Date.now();
  assert.equal(await askReasoner("t", {}, { command, ...opts }), null, label);
  if (label === "timeout") assert.ok(Date.now() - started < 3000, "the timeout must kill the command");
}

// --- The scanner is string-aware and takes the first object only.
assert.deepEqual(firstJsonObject('x {"why":"a {brace} inside","n":1} {"second":2}'), {
  why: "a {brace} inside",
  n: 1,
});
assert.equal(firstJsonObject("no json here"), null);
assert.equal(firstJsonObject("{not: valid}"), null);

// --- The prompt carries the contract, the task and the input, in that order.
const prompt = reasonerPrompt("pick one", { k: "v" });
assert.ok(prompt.indexOf("single JSON object") < prompt.indexOf("pick one"));
assert.ok(prompt.indexOf("pick one") < prompt.indexOf('"k": "v"'));

console.log("reasoner: all checks passed");
