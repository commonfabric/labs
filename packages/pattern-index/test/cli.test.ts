import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { Identity } from "@commonfabric/identity";
import { verifyFirstPartyHttpRequest } from "@commonfabric/runner/toolshed-http-auth";

const root = fromFileUrl(new URL("../../../", import.meta.url));
const entry = fromFileUrl(new URL("../cli.ts", import.meta.url));
const decoder = new TextDecoder();

interface IndexCall {
  fn: string;
  did: string;
  body: Record<string, unknown>;
}

/** Runs the public helper with the exact CFS flags and permission grants. */
const callHelper = async (
  directory: string,
  baseUrl: string,
  input: unknown,
  identity = `${directory}/identity.key`,
) => {
  const child = new Deno.Command(Deno.execPath(), {
    cwd: directory,
    args: [
      "run",
      "--no-lock",
      "--config",
      `${root}/deno.jsonc`,
      `--allow-read=${identity}`,
      "--allow-net=127.0.0.1",
      entry,
      "--identity",
      identity,
      "--base-url",
      baseUrl,
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(
    typeof input === "string" ? input : JSON.stringify(input),
  ));
  await writer.close();
  const output = await child.output();
  return {
    code: output.code,
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr),
  };
};

const pattern = (patternId: string, priorPatternId?: string) => ({
  patternId,
  ownerDid: "did:example:publisher",
  createdAt: "2026-10-09T00:00:00Z",
  description: patternId,
  hashtags: ["test"],
  dependencies: [],
  ...(priorPatternId === undefined ? {} : { priorPatternId }),
});

const listed = (patternId: string) => ({
  ...pattern(patternId),
  keywords: [],
  events: {},
  score: 0,
  quality: "unproven",
});

describe("cli", () => {
  let directory: string;
  let baseUrl: string;
  let did: string;
  let server: Deno.HttpServer<Deno.NetAddr>;
  let calls: IndexCall[];
  let reply: (call: IndexCall) => Response;

  beforeEach(async () => {
    directory = await Deno.makeTempDir({ prefix: "pattern-index-cli-" });
    const key = await Identity.generatePkcs8();
    did = (await Identity.fromPkcs8(key)).did();
    await Deno.writeFile(`${directory}/identity.key`, key);
    calls = [];
    reply = () => Response.json({ ok: true });
    server = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen() {} },
      async (request) => {
        const { userDid } = await verifyFirstPartyHttpRequest({ request });
        const call = {
          fn: new URL(request.url).pathname.split("/").at(-1)!,
          did: userDid,
          body: await request.json(),
        };
        calls.push(call);
        return reply(call);
      },
    );
    baseUrl = `http://127.0.0.1:${server.addr.port}/index`;
  });

  afterEach(async () => {
    await server.shutdown();
    await Deno.remove(directory, { recursive: true });
  });

  it("returns successors from a signed search and rebuilds its fields", async () => {
    reply = ({ fn, body }) => {
      switch (fn) {
        case "searchPatterns":
          return Response.json({
            results: [{ ...pattern("old"), kind: "app", quality: "unproven" }],
          });
        case "listPatterns":
          return Response.json({
            patterns: [listed("old"), listed("fresh")],
            eventTypes: {},
          });
        case "getPattern":
          return Response.json(
            pattern(
              String(body.patternId),
              body.patternId === "fresh" ? "old" : undefined,
            ),
          );
        default:
          throw new Error(`unexpected index function: ${fn}`);
      }
    };
    const output = await callHelper(directory, baseUrl, {
      op: "search",
      text: "test",
      tags: ["test", 1],
      limit: 3,
      includeSource: true,
      fn: "publishPattern",
      did: "forged",
    });
    expect(output.code).toBe(0);
    expect(JSON.parse(output.stdout)).toEqual({
      ok: true,
      value: {
        results: [{
          ...pattern("fresh"),
          kind: "app",
          quality: "unproven",
          signals: { uses: 0, score: 0 },
        }],
      },
    });
    expect(calls.map((call) => call.did)).toEqual([did, did, did, did]);
    expect(calls[0].body).toEqual({ text: "test", tags: ["test"], limit: 3 });
    expect(
      calls.filter((call) => call.fn === "getPattern").map((call) => call.body),
    )
      .toEqual([{ patternId: "old", includeSource: false }, {
        patternId: "fresh",
        includeSource: false,
      }]);
  });

  for (
    const [verdict, eventType] of [["up", "thumbs_up"], ["down", "thumbs_down"]]
  ) {
    it(`records a signed ${verdict} vote under its own identity`, async () => {
      const output = await callHelper(directory, baseUrl, {
        op: "feedback",
        patternId: "test",
        verdict,
        did: "forged",
        note: "ignored",
      });
      expect(output.code).toBe(0);
      expect(JSON.parse(output.stdout)).toEqual({
        ok: true,
        value: { patternId: "test", eventType, recordedBy: did },
      });
      expect(calls).toEqual([{
        fn: "recordEvent",
        did,
        body: { patternId: "test", eventType, did },
      }]);
    });
  }

  it("returns 400 for malformed and unsupported requests without calling the index", async () => {
    for (
      const [request, error] of [
        [
          { op: "feedback", patternId: "test", verdict: "constructor" },
          'verdict must be "up" or "down"',
        ],
        [{ op: "feedback", verdict: "up" }, "patternId is required"],
        [
          { op: "getPattern", includeSource: true },
          "op must be search or feedback",
        ],
        [null, "op must be search or feedback"],
        ["{", "request body is not JSON"],
      ]
    ) {
      const output = await callHelper(directory, baseUrl, request);
      expect(output.code).toBe(0);
      expect(JSON.parse(output.stdout)).toEqual({
        ok: false,
        status: 400,
        error,
      });
    }
    expect(calls).toEqual([]);
  });

  for (const status of [401, 403, 404, 429, 500]) {
    it(`returns a safe refusal for index status ${status}`, async () => {
      reply = () =>
        Response.json({ error: "private server detail" }, { status });
      const output = await callHelper(directory, baseUrl, {
        op: "feedback",
        patternId: "test",
        verdict: "up",
      });
      expect(output.code).toBe(0);
      expect(output.stderr).not.toContain("private server detail");
      expect(JSON.parse(output.stdout)).toEqual({
        ok: false,
        status: status < 500 ? status : 502,
        error: `pattern index recordEvent failed (${status})`,
      });
    });
  }

  it("returns 502 when an index answer is unreadable or the event was not recorded", async () => {
    for (
      const response of [
        new Response("private non-JSON detail"),
        Response.json({ ok: false }),
      ]
    ) {
      reply = () => response;
      const output = await callHelper(directory, baseUrl, {
        op: "feedback",
        patternId: "test",
        verdict: "up",
      });
      expect(output.code).toBe(0);
      expect(JSON.parse(output.stdout)).toEqual({
        ok: false,
        status: 502,
        error:
          response.headers.get("content-type")?.includes("application/json")
            ? "the pattern index answered but did not record the thumbs_up event"
            : "pattern index recordEvent failed (200)",
      });
    }
  });

  it("exits nonzero with only stderr for an internal successor-resolution failure", async () => {
    reply = ({ fn, body }) => {
      switch (fn) {
        case "searchPatterns":
          return Response.json({
            results: [{ ...pattern("old"), kind: "app", quality: "unproven" }],
          });
        case "listPatterns":
          return Response.json({
            patterns: [listed("old"), listed("fresh")],
            eventTypes: {},
          });
        case "getPattern":
          return Response.json(
            pattern(
              String(body.patternId),
              body.patternId === "old" ? "fresh" : "old",
            ),
          );
        default:
          throw new Error(`unexpected index function: ${fn}`);
      }
    };
    const output = await callHelper(directory, baseUrl, {
      op: "search",
      text: "test",
    });
    expect(output.code).not.toBe(0);
    expect(output.stdout).toBe("");
    expect(output.stderr).toContain("successor chain is ambiguous or cyclic");
  });

  it("exits nonzero with only stderr when the identity key cannot be read", async () => {
    const output = await callHelper(
      directory,
      baseUrl,
      { op: "search" },
      `${directory}/missing.key`,
    );
    expect(output.code).not.toBe(0);
    expect(output.stdout).toBe("");
    expect(output.stderr).toContain("failed host-side");
    expect(calls).toEqual([]);
  });
});
