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

// --- runReasoner: the reason travels, the placeholders fill, agy's own shapes are read ----------
{
  const { runReasoner, reasonerArgs, NOT_SIGNED_IN } = await import("./reasoner.js");

  // `{schema}` and `{dir}` fill in; without values they go, and the flag before each with them,
  // so the lab's one agy argv also serves the caller that passes neither.
  const argv = ["-p", "{prompt}", "--json-schema", "{schema}", "--add-dir", "{dir}", "--sandbox"];
  assert.deepEqual(reasonerArgs(argv, "P", { schema: { type: "object" }, dir: "/m" }), [
    "-p",
    "P",
    "--json-schema",
    '{"type":"object"}',
    "--add-dir",
    "/m",
    "--sandbox",
  ]);
  assert.deepEqual(reasonerArgs(argv, "P"), ["-p", "P", "--sandbox"]);

  // `--json-schema` puts the answer in `structured_output`, and it wins over `response`.
  const structured = await runReasoner("x", {
    command: nodeE(
      `console.log(JSON.stringify({status:"SUCCESS",response:"see structured",structured_output:{startSec:3}}))`,
    ),
  });
  assert.deepEqual(structured.ok && structured.answer, { startSec: 3 });

  // Not signed in: agy prints the OAuth prompt on stderr and would wait a minute; it is stopped
  // at once and the reason is the one line the operator can act on.
  const started = Date.now();
  const signIn = await runReasoner("x", {
    command: nodeE(
      `console.error("Authentication required. Please visit the URL to log in:");setTimeout(()=>{},60000)`,
    ),
    timeoutMs: 30_000,
  });
  assert.deepEqual([signIn.ok, !signIn.ok && signIn.error], [false, NOT_SIGNED_IN]);
  assert.ok(Date.now() - started < 3000, "the sign-in prompt is not waited out");
  // …and the envelope agy prints when its own wait runs out says the same.
  const envelopeOnly = await runReasoner("x", {
    command: nodeE(
      `console.log(JSON.stringify({status:"ERROR",response:"",error:"authentication failed or timed out"}));process.exit(1)`,
    ),
  });
  assert.equal(!envelopeOnly.ok && envelopeOnly.error, NOT_SIGNED_IN);

  // Any other ERROR envelope names itself.
  const errored = await runReasoner("x", {
    command: nodeE(
      `console.log(JSON.stringify({status:"ERROR",response:"",error:"quota exhausted"}));process.exit(1)`,
    ),
  });
  assert.match(!errored.ok ? errored.error : "", /exited 1: answered ERROR: quota exhausted/);

  // The timeout says so, and `raw` keeps what was printed.
  const slow = await runReasoner("x", {
    command: nodeE(`console.log("thinking");setTimeout(()=>{},5000)`),
    timeoutMs: 200,
  });
  assert.deepEqual(
    [slow.ok, !slow.ok && slow.error, slow.raw],
    [false, "node timed out after 200 ms", "thinking"],
  );

  // An abort is the one rejection: the caller asked for it.
  const controller = new AbortController();
  const pending = runReasoner("x", { command: nodeE("setTimeout(()=>{},5000)"), signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(pending, (err: Error) => err.name === "AbortError");
  console.log(
    "OK: runReasoner fills placeholders, reads structured_output, names sign-in, timeout and abort",
  );
}

console.log("reasoner: all checks passed");
