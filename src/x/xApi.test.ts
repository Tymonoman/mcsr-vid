// src/x/xApi.ts against X's own documents and an in-process stand-in for api.x.com (node:http):
// the OAuth 1.0a signature X's "Creating a signature" page works through, and the upload + post
// request shapes from its "Chunked Media Upload" guide (both read 14 Oct 2026). No real X call.
// Run: npx tsx src/x/xApi.test.ts
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { authHeader, createPost, isXConfigured, oauthSignature, uploadVideo, type XKeys } from "./xApi.js";

/* --- X's documented example (docs.x.com/fundamentals/authentication/oauth-1-0a/creating-a-signature) */
const docParams = {
  status: "Hello Ladies + Gentlemen, a signed OAuth request!",
  include_entities: "true",
  oauth_consumer_key: "xvz1evFS4wEEPTGEFPHBog",
  oauth_nonce: "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
  oauth_signature_method: "HMAC-SHA1",
  oauth_timestamp: "1318622958",
  oauth_token: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
  oauth_version: "1.0",
};
const docSecrets = [
  "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
  "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE",
] as const;
// Today's page signs api.x.com; the long-quoted original signed api.twitter.com. Both must hold.
assert.equal(
  oauthSignature("POST", "https://api.x.com/1.1/statuses/update.json", docParams, ...docSecrets),
  "Ls93hJiZbQ3akF3HF3x1Bz8/zU4=",
);
assert.equal(
  oauthSignature("POST", "https://api.twitter.com/1.1/statuses/update.json", docParams, ...docSecrets),
  "hCtSmYh+iHYCEqBWrE7C7hYmtUk=",
);
console.log("OK: the signature matches X's documented example (api.x.com and api.twitter.com)");

/* --- keys -------------------------------------------------------------------------------------- */
const env = {
  X_API_KEY: "ck-test",
  X_API_SECRET: "cs-test",
  X_ACCESS_TOKEN: "at-test",
  X_ACCESS_SECRET: "as-test",
};
for (const missing of Object.keys(env)) {
  Object.assign(process.env, env);
  delete process.env[missing];
  assert.equal(isXConfigured(), false, `not configured without ${missing}`);
}
Object.assign(process.env, env);
assert.equal(isXConfigured(), true);
console.log("OK: isXConfigured needs all four keys");
const keys: XKeys = {
  apiKey: "ck-test",
  apiSecret: "cs-test",
  accessToken: "at-test",
  accessSecret: "as-test",
};

/* --- the mock api.x.com -------------------------------------------------------------------------- */
interface Seen {
  method: string;
  path: string;
  type: string;
}
const seen: Seen[] = [];
const segments: Buffer[] = [];
let statusPolls = 0;
let processing: "succeeds" | "fails" = "succeeds";
let tweetStatus = 201;

/** The header carries every oauth_* param, and its signature is the one this request deserves. */
function checkAuth(req: IncomingMessage, url: URL): void {
  const header = req.headers.authorization ?? "";
  assert.match(header, /^OAuth /, `${url.pathname}: an OAuth Authorization header`);
  const oauth = Object.fromEntries(
    [...header.slice(6).matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1]!, decodeURIComponent(m[2]!)]),
  );
  assert.equal(oauth.oauth_consumer_key, keys.apiKey);
  assert.equal(oauth.oauth_token, keys.accessToken);
  assert.equal(oauth.oauth_signature_method, "HMAC-SHA1");
  assert.ok(
    !header.includes(keys.apiSecret) && !header.includes(keys.accessSecret),
    "no secret in the header",
  );
  const { oauth_signature, ...signed } = oauth;
  assert.equal(
    oauth_signature,
    oauthSignature(
      req.method!,
      `${url.origin}${url.pathname}`,
      { ...Object.fromEntries(url.searchParams), ...signed },
      keys.apiSecret,
      keys.accessSecret,
    ),
    `${url.pathname}: the signature verifies`,
  );
}

const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks);
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const type = req.headers["content-type"] ?? "";
  seen.push({ method: req.method!, path: url.pathname, type });
  const reply = (status: number, json: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(json));
  };
  try {
    checkAuth(req, url);
    if (req.method === "POST" && url.pathname === "/2/media/upload/initialize") {
      assert.match(type, /^application\/json/);
      assert.deepEqual(JSON.parse(body.toString()), {
        media_type: "video/mp4",
        total_bytes: clip.length,
        media_category: "tweet_video",
      });
      return reply(200, { data: { id: "1880028106020515840", media_key: "13_1880028106020515840" } });
    }
    if (req.method === "POST" && url.pathname === "/2/media/upload/1880028106020515840/append") {
      assert.match(type, /^multipart\/form-data/);
      const form = await new Response(body, { headers: { "content-type": type } }).formData();
      assert.equal(
        form.get("segment_index"),
        String(segments.length),
        "segments are numbered from 0, in order",
      );
      const media = form.get("media");
      assert.ok(media instanceof Blob);
      assert.ok(media.size <= 5 * 1024 * 1024, "a segment stays at or below 5 MB");
      segments.push(Buffer.from(await media.arrayBuffer()));
      return reply(200, {});
    }
    if (req.method === "POST" && url.pathname === "/2/media/upload/1880028106020515840/finalize") {
      return reply(200, {
        data: { id: "1880028106020515840", processing_info: { state: "pending", check_after_secs: 1 } },
      });
    }
    if (req.method === "GET" && url.pathname === "/2/media/upload") {
      assert.equal(url.searchParams.get("command"), "STATUS");
      assert.equal(url.searchParams.get("media_id"), "1880028106020515840");
      statusPolls++;
      const state = statusPolls < 2 ? "in_progress" : processing === "fails" ? "failed" : "succeeded";
      return reply(200, {
        data: { id: "1880028106020515840", processing_info: { state, check_after_secs: 2 } },
      });
    }
    if (req.method === "POST" && url.pathname === "/2/tweets") {
      assert.match(type, /^application\/json/);
      assert.deepEqual(JSON.parse(body.toString()), {
        text: "HOOK | A vs B\nhttps://youtu.be/abc\n#mcsr #minecraft",
        media: { media_ids: ["1880028106020515840"] },
      });
      if (tweetStatus !== 201)
        return reply(tweetStatus, { title: "Forbidden", detail: "not allowed", status: 403 });
      return reply(201, { data: { id: "1846987139428634858", text: "HOOK" } });
    }
    reply(404, { error: `unexpected ${req.method} ${url.pathname}` });
  } catch (err) {
    reply(400, { error: String(err) });
  }
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const dir = mkdtempSync(path.join(tmpdir(), "mcsr-xapi-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
// Two segments: one full 4 MB, one remainder — the clip comes back byte for byte.
const clip = randomBytes(4 * 1024 * 1024 + 12_345);
const file = path.join(dir, "short.mp4");
writeFileSync(file, clip);

const slept: number[] = [];
const mediaId = await uploadVideo(file, keys, base, async (ms) => slept.push(ms));
assert.equal(mediaId, "1880028106020515840");
assert.equal(segments.length, 2);
assert.ok(Buffer.concat(segments).equals(clip), "the appended segments are the file");
assert.deepEqual(
  seen.map((s) => `${s.method} ${s.path}`),
  [
    "POST /2/media/upload/initialize",
    "POST /2/media/upload/1880028106020515840/append",
    "POST /2/media/upload/1880028106020515840/append",
    "POST /2/media/upload/1880028106020515840/finalize",
    "GET /2/media/upload",
    "GET /2/media/upload",
  ],
);
assert.deepEqual(slept, [1000, 2000], "STATUS waits check_after_secs between polls");
console.log("OK: INIT (JSON) → APPEND ×2 (multipart, ≤5 MB, in order) → FINALIZE → STATUS until succeeded");

const postId = await createPost(keys, "HOOK | A vs B\nhttps://youtu.be/abc\n#mcsr #minecraft", mediaId, base);
assert.equal(postId, "1846987139428634858");
console.log("OK: POST /2/tweets carries the text and media_ids, returns the post id");

/* --- failures ------------------------------------------------------------------------------------ */
tweetStatus = 403;
await assert.rejects(
  createPost(keys, "HOOK | A vs B\nhttps://youtu.be/abc\n#mcsr #minecraft", mediaId, base),
  (err: Error) =>
    /\/2\/tweets: 403/.test(err.message) &&
    !Object.values(keys).some((k) => err.message.includes(k)) &&
    !err.message.includes("oauth_signature"),
);
console.log("OK: an X refusal throws with the path and status, never a key or the signature");

processing = "fails";
statusPolls = 0;
segments.length = 0;
await assert.rejects(
  uploadVideo(file, keys, base, async () => {}),
  /could not process the video/,
);
console.log("OK: a failed processing state throws");

server.close();
// authHeader with fixed inputs is stable and signs its query (the STATUS call relies on it).
assert.equal(
  authHeader("GET", "https://api.x.com/2/media/upload?command=STATUS&media_id=1", keys, "n", 1),
  authHeader("GET", "https://api.x.com/2/media/upload?media_id=1&command=STATUS", keys, "n", 1),
);
assert.notEqual(
  authHeader("GET", "https://api.x.com/2/media/upload?command=STATUS&media_id=1", keys, "n", 1),
  authHeader("GET", "https://api.x.com/2/media/upload?command=STATUS&media_id=2", keys, "n", 1),
);
console.log("OK: the query is signed, in any order");
console.log("xApi: all checks passed");
