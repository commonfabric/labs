import { deployedPieceRef } from "../src/client.ts";
import { expect } from "@std/expect";
import { fromFileUrl, join } from "@std/path";
import {
  fromBase64url,
  toUnpaddedBase64url,
} from "@commonfabric/bytes/base64url";
import { checkIndexChain, issueIndexChain } from "../src/membership.ts";
import { PatternIndexStore } from "../src/store.ts";
import { encodeDelegationChains, Identity } from "@commonfabric/identity";
import { verifyFirstPartyHttpRequest } from "@commonfabric/runner/toolshed-http-auth";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

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
  membershipStore?: string,
) => {
  const child = new Deno.Command(Deno.execPath(), {
    cwd: directory,
    args: [
      "run",
      "--no-lock",
      "--config",
      `${root}/deno.jsonc`,
      membershipStore === undefined
        ? `--allow-read=${identity}`
        : `--allow-read=${identity},${membershipStore}`,
      ...(membershipStore === undefined
        ? []
        : [`--allow-write=${membershipStore}`]),
      "--allow-net=127.0.0.1",
      entry,
      "--identity",
      identity,
      "--base-url",
      baseUrl,
      ...(membershipStore === undefined
        ? []
        : ["--membership-store", membershipStore]),
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

const pattern = (patternId: string) => ({
  patternId,
  ownerDid: "did:example:publisher",
  createdAt: "2026-10-09T00:00:00Z",
  description: patternId,
  hashtags: ["test"],
  dependencies: [],
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

  it("answers a signed search with the index's rows as sent", async () => {
    // The index resolves successors, so the helper relays a replacement row,
    // its display name, and what it supersedes without reading further.
    const answer = {
      results: [{
        ...pattern("fresh"),
        name: "Fresh",
        kind: "app",
        quality: "unproven",
        signals: { uses: 0, score: 0 },
        supersedes: "old",
      }],
      successorsResolved: true,
    };
    reply = () => Response.json(answer);

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
    expect(JSON.parse(output.stdout)).toEqual({ ok: true, value: answer });
    expect(calls).toEqual([{
      fn: "searchPatterns",
      did,
      body: { text: "test", tags: ["test"], limit: 3 },
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

  it("answers each pattern's source in the order asked, and the index's refusal of one beside the others", async () => {
    const program = {
      main: "main.tsx",
      files: [{ name: "main.tsx", contents: "export default 1;" }],
    };
    reply = (call) =>
      call.body.patternId === "gone"
        ? Response.json({ error: "not found" }, { status: 404 })
        : Response.json({
          ...pattern(String(call.body.patternId)),
          name: "Lunch",
          mine: false,
          program,
        });

    const output = await callHelper(directory, baseUrl, {
      op: "source",
      patternIds: ["lunch", "gone"],
    });

    expect(output.code).toBe(0);
    expect(JSON.parse(output.stdout)).toEqual({
      ok: true,
      value: {
        patterns: [
          {
            patternId: "lunch",
            name: "Lunch",
            description: "lunch",
            mine: false,
            program,
          },
          { patternId: "gone", status: 404 },
        ],
      },
    });
    expect(calls.map((call) => [call.fn, call.body])).toEqual([
      ["getPattern", { patternId: "lunch", includeSource: true }],
      ["getPattern", { patternId: "gone", includeSource: true }],
    ]);
  });

  it("answers a source request the index refuses as a whole with the index's status, and a withheld program as 403", async () => {
    reply = () => Response.json({ error: "not allowlisted" }, { status: 403 });
    const refused = await callHelper(directory, baseUrl, {
      op: "source",
      patternIds: ["lunch"],
    });
    expect(JSON.parse(refused.stdout)).toMatchObject({
      ok: false,
      status: 403,
    });

    reply = (call) => Response.json(pattern(String(call.body.patternId)));
    const withheld = await callHelper(directory, baseUrl, {
      op: "source",
      patternIds: ["lunch"],
    });
    expect(JSON.parse(withheld.stdout)).toEqual({
      ok: true,
      value: { patterns: [{ patternId: "lunch", status: 403 }] },
    });
  });

  it("refuses a source request naming no patterns, too many, or one that is not a string, calling nothing", async () => {
    for (
      const patternIds of [[], ["a", "b", "c", "d", "e", "f"], ["a", 1], "a"]
    ) {
      const output = await callHelper(directory, baseUrl, {
        op: "source",
        patternIds,
      });
      expect(JSON.parse(output.stdout)).toMatchObject({
        ok: false,
        status: 400,
      });
    }
    expect(calls).toEqual([]);
  });

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
          "op must be search, feedback, source, whoami, admit, join, chain, view, getSharing or setSharing",
        ],
        [
          null,
          "op must be search, feedback, source, whoami, admit, join, chain, view, getSharing or setSharing",
        ],
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
            : "pattern index recordEvent answer is malformed: it is not JSON",
      });
    }
  });

  it("exits 2 with usage on stderr when a required flag is missing", async () => {
    const child = new Deno.Command(Deno.execPath(), {
      cwd: directory,
      args: [
        "run",
        "--no-lock",
        "--config",
        `${root}/deno.jsonc`,
        entry,
        "--identity",
        `${directory}/identity.key`,
      ],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    });
    const output = await child.output();

    expect(output.code).toBe(2);
    expect(decoder.decode(output.stdout)).toBe("");
    expect(decoder.decode(output.stderr)).toContain(
      "usage: cli.ts --identity <path> --base-url <url>",
    );
    expect(calls).toEqual([]);
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

  it("exits nonzero with only stderr when the index cannot be reached", async () => {
    // A port nothing listens on: the transport fails rather than the index
    // refusing, which is a host failure and not an answer.
    const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    const { port } = listener.addr as Deno.NetAddr;
    listener.close();

    const output = await callHelper(
      directory,
      `http://127.0.0.1:${port}/index`,
      { op: "search", text: "test" },
    );

    expect(output.code).not.toBe(0);
    expect(output.stdout).toBe("");
    expect(output.stderr).toContain("failed host-side");
  });

  it("presents the chain the membership store holds for its identity", async () => {
    const stores = `${directory}/stores`;
    const store = new PatternIndexStore(
      join(stores, new URL(baseUrl).host),
    );
    const root = await store.createRootKey();
    await store.recordMembership({
      handle: "p-1",
      role: "user",
      root: root.did(),
    });

    const output = await callHelper(
      directory,
      baseUrl,
      { op: "search", text: "test" },
      `${directory}/identity.key`,
      stores,
    );

    expect(output.code).toBe(0);
    const proofs = calls[0].body.proofs as string[];
    const checked = await checkIndexChain(
      proofs.map((link) => fromBase64url(link)),
      did as `did:key:${string}`,
    );
    expect(checked.root).toBe(root.did());
    expect(await store.chainFor(did as `did:key:${string}`)).toHaveLength(1);
  });

  it("answers whoami with the member and the signing key", async () => {
    reply = () => Response.json({ handle: "p-1", role: "user" });

    const output = await callHelper(directory, baseUrl, { op: "whoami" });

    expect(JSON.parse(output.stdout)).toEqual({
      ok: true,
      value: { handle: "p-1", role: "user", signer: did },
    });
  });

  const PIECE = "piece:" + "ab".repeat(32);

  it("sends a view of a piece or of a pattern as the member's viewed_in_loom", async () => {
    reply = () => Response.json({ ok: true, recorded: false });
    for (
      const [request, sent] of [
        [{ op: "view", piece: PIECE }, { piece: PIECE }],
        [{ op: "view", patternId: "pat-1" }, { patternId: "pat-1" }],
      ] as const
    ) {
      const output = await callHelper(directory, baseUrl, request);
      expect(JSON.parse(output.stdout)).toMatchObject({ ok: true });
      expect(calls.at(-1)?.fn).toBe("recordEvent");
      expect(calls.at(-1)?.body).toMatchObject({
        ...sent,
        eventType: "viewed_in_loom",
      });
    }
  });

  it("keys a piece exactly as Loom does, so Loom's views reach the versions run_pattern and cf deployed", async () => {
    // The same literal is pinned in Loom (tests/pattern_index/test_pattern_index_usage.py).
    expect(await deployedPieceRef("did:key:z6Mkspace", "of:fid1:note")).toBe(
      "piece:964d427d05870c59302580ffd9745a4b6e09a7e64ad6e83454ddbb89ebaf3a90",
    );
  });

  it("answers 502 for a view the index answered ok:false", async () => {
    reply = () => Response.json({ ok: false });
    const output = await callHelper(directory, baseUrl, {
      op: "view",
      piece: PIECE,
    });
    expect(JSON.parse(output.stdout)).toMatchObject({ ok: false, status: 502 });
  });

  it("refuses a view naming both, neither, or a piece that is not a piece key, calling nothing", async () => {
    for (
      const request of [
        { op: "view" },
        { op: "view", piece: PIECE, patternId: "p" },
        { op: "view", piece: "did:key:z/fid1:raw" },
        { op: "view", piece: "piece:abc" },
      ]
    ) {
      const output = await callHelper(directory, baseUrl, request);
      expect(JSON.parse(output.stdout)).toMatchObject({
        ok: false,
        status: 400,
      });
    }
    expect(calls).toEqual([]);
  });

  it("reads the member's sharing settings", async () => {
    const settings = { enabled: false, selfBuilt: true, updatedAt: null };
    reply = () => Response.json(settings);

    const output = await callHelper(directory, baseUrl, { op: "getSharing" });

    expect(JSON.parse(output.stdout)).toEqual({ ok: true, value: settings });
    expect(calls.map((call) => call.fn)).toEqual(["getSharingSettings"]);
  });

  it("changes only the sharing switches the request set", async () => {
    reply = () =>
      Response.json({ enabled: false, selfBuilt: true, updatedAt: "t" });

    const output = await callHelper(directory, baseUrl, {
      op: "setSharing",
      enabled: false,
    });

    expect(JSON.parse(output.stdout)).toMatchObject({
      ok: true,
      value: { enabled: false, selfBuilt: true },
    });
    expect(calls.map((call) => call.fn)).toEqual(["setSharingSettings"]);
    expect(calls[0].body.enabled).toBe(false);
    expect("selfBuilt" in calls[0].body).toBe(false);
  });

  it("refuses a sharing change that sets nothing, or a switch that is not a boolean, calling nothing", async () => {
    for (
      const request of [
        { op: "setSharing" },
        { op: "setSharing", enabled: "false" },
        { op: "setSharing", enabled: true, selfBuilt: 0 },
      ]
    ) {
      const output = await callHelper(directory, baseUrl, request);
      expect(JSON.parse(output.stdout)).toMatchObject({
        ok: false,
        status: 400,
      });
    }
    expect(calls).toEqual([]);
  });

  it("returns 400 for admit without a did:key, calling nothing", async () => {
    const output = await callHelper(directory, baseUrl, {
      op: "admit",
      did: "not-a-did",
    });

    expect(JSON.parse(output.stdout)).toMatchObject({ ok: false, status: 400 });
    expect(calls).toEqual([]);
  });

  it("joins with an invite link into the store, redeeming with a new index-only root", async () => {
    const stores = `${directory}/stores`;
    reply = (call) =>
      Response.json(
        call.fn === "redeemInvite"
          ? { handle: "p-7", role: "user" }
          : { handle: "p-7", role: "user" },
      );

    const output = await callHelper(
      directory,
      baseUrl,
      {
        op: "join",
        link: "https://fbrc.social/index-join?invite=inv1#code=the-code",
      },
      `${directory}/identity.key`,
      stores,
    );

    const answer = JSON.parse(output.stdout);
    expect(answer).toMatchObject({
      ok: true,
      value: { handle: "p-7", signer: did, joined: true },
    });
    const store = new PatternIndexStore(join(stores, new URL(baseUrl).host));
    const root = (await store.rootKey())!;
    expect(answer.value.root).toBe(root.did());
    expect(calls[0]).toMatchObject({
      fn: "redeemInvite",
      did: root.did(),
      body: { inviteId: "inv1", code: "the-code" },
    });
    expect(calls[1].did).toBe(did);
    expect(calls[1].body.proofs).toHaveLength(1);
  });

  it("joins with a chain file into the store, keeping no root key", async () => {
    const stores = `${directory}/stores`;
    const member = await Identity.fromPassphrase("cli chain root");
    const chain = await issueIndexChain({
      issuer: member,
      to: did as `did:key:${string}`,
      held: [],
    });
    reply = () => Response.json({ handle: "p-8", role: "user" });

    const output = await callHelper(
      directory,
      baseUrl,
      { op: "join", chain: encodeDelegationChains([chain]) },
      `${directory}/identity.key`,
      stores,
    );

    expect(JSON.parse(output.stdout)).toMatchObject({
      ok: true,
      value: { handle: "p-8", root: member.did(), rootKeptHere: false },
    });
    expect(calls.map((call) => call.fn)).toEqual(["whoami"]);
    const store = new PatternIndexStore(join(stores, new URL(baseUrl).host));
    expect(await store.rootKey()).toBeUndefined();
  });

  it("returns 400 for a join whose chain is not a chain file, calling nothing", async () => {
    const output = await callHelper(
      directory,
      baseUrl,
      { op: "join", chain: "not json" },
      `${directory}/identity.key`,
      `${directory}/stores`,
    );

    expect(JSON.parse(output.stdout)).toEqual({
      ok: false,
      status: 400,
      error: "chain is not a chain file",
    });
    expect(calls).toEqual([]);
  });

  it("returns 400 for a join whose chain file holds two chains, calling nothing", async () => {
    const member = await Identity.fromPassphrase("cli chain root");
    const chain = await issueIndexChain({
      issuer: member,
      to: did as `did:key:${string}`,
      held: [],
    });

    const output = await callHelper(
      directory,
      baseUrl,
      { op: "join", chain: encodeDelegationChains([chain, chain]) },
      `${directory}/identity.key`,
      `${directory}/stores`,
    );

    expect(JSON.parse(output.stdout)).toMatchObject({
      ok: false,
      status: 400,
      error: "chain must hold exactly one chain",
    });
    expect(calls).toEqual([]);
  });

  it("returns 400 for a join with neither a link nor a chain", async () => {
    const output = await callHelper(
      directory,
      baseUrl,
      { op: "join" },
      `${directory}/identity.key`,
      `${directory}/stores`,
    );

    expect(JSON.parse(output.stdout)).toMatchObject({ ok: false, status: 400 });
    expect(calls).toEqual([]);
  });

  it("answers admit with the admitted member, sending the did", async () => {
    const admitted = await Identity.fromPassphrase("cli admitted key");
    reply = () => Response.json({ handle: "p-9", role: "user" });

    const output = await callHelper(directory, baseUrl, {
      op: "admit",
      did: admitted.did(),
    });

    expect(JSON.parse(output.stdout)).toEqual({
      ok: true,
      value: { handle: "p-9", role: "user" },
    });
    expect(calls[0]).toMatchObject({
      fn: "admitKey",
      body: { did: admitted.did() },
    });
  });

  it("returns the index's status for a refused invite, never the code", async () => {
    reply = () => Response.json({ error: "used" }, { status: 409 });

    const output = await callHelper(
      directory,
      baseUrl,
      {
        op: "join",
        link: "https://fbrc.social/index-join?invite=inv1#code=the-code",
      },
      `${directory}/identity.key`,
      `${directory}/stores`,
    );

    expect(output.code).toBe(0);
    expect(JSON.parse(output.stdout)).toMatchObject({ ok: false, status: 409 });
    expect(output.stdout + output.stderr).not.toContain("the-code");
  });

  it("returns 400 for a join given both a link and a chain, calling nothing", async () => {
    const output = await callHelper(
      directory,
      baseUrl,
      {
        op: "join",
        link: "https://fbrc.social/index-join?invite=inv1#code=the-code",
        chain: "{}",
      },
      `${directory}/identity.key`,
      `${directory}/stores`,
    );

    expect(JSON.parse(output.stdout)).toMatchObject({ ok: false, status: 400 });
    expect(calls).toEqual([]);
  });

  it("returns 400 for a join without a membership store, calling nothing", async () => {
    const output = await callHelper(directory, baseUrl, {
      op: "join",
      link: "https://fbrc.social/index-join?invite=inv1#code=the-code",
    });

    expect(JSON.parse(output.stdout)).toMatchObject({ ok: false, status: 400 });
    expect(calls).toEqual([]);
  });

  it("hands over the chain the kept root issued, which joins another machine holding the key", async () => {
    const stores = `${directory}/stores`;
    const store = new PatternIndexStore(join(stores, new URL(baseUrl).host));
    const root = await store.createRootKey();
    await store.recordMembership({
      handle: "p-1",
      role: "user",
      root: root.did(),
    });

    const output = await callHelper(
      directory,
      baseUrl,
      { op: "chain" },
      `${directory}/identity.key`,
      stores,
    );

    const answer = JSON.parse(output.stdout);
    expect(answer.ok).toBe(true);
    expect(calls).toEqual([]);
    reply = () => Response.json({ handle: "p-1", role: "user" });
    const elsewhere = `${directory}/elsewhere`;
    const joined = await callHelper(
      directory,
      baseUrl,
      { op: "join", chain: answer.value.chain },
      `${directory}/identity.key`,
      elsewhere,
    );
    expect(JSON.parse(joined.stdout)).toMatchObject({
      ok: true,
      value: { handle: "p-1", root: root.did(), rootKeptHere: false },
    });
    expect(calls[0].body.proofs).toEqual(
      (await store.chainFor(did as `did:key:${string}`))!.map((link) =>
        toUnpaddedBase64url(link)
      ),
    );
  });

  it("refuses a chain where it holds no membership, or where the identity is the root", async () => {
    const stores = `${directory}/stores`;
    const none = await callHelper(
      directory,
      baseUrl,
      { op: "chain" },
      `${directory}/identity.key`,
      stores,
    );
    expect(JSON.parse(none.stdout)).toMatchObject({ ok: false, status: 404 });

    const store = new PatternIndexStore(join(stores, new URL(baseUrl).host));
    await store.recordMembership({
      handle: "p-1",
      role: "user",
      root: did as `did:key:${string}`,
    });
    const own = await callHelper(
      directory,
      baseUrl,
      { op: "chain" },
      `${directory}/identity.key`,
      stores,
    );
    expect(JSON.parse(own.stdout)).toMatchObject({ ok: false, status: 409 });

    // A chain held from some other root is never handed over as this member's.
    const elsewhere = new PatternIndexStore(
      join(`${directory}/other`, new URL(baseUrl).host),
    );
    await elsewhere.recordMembership({
      handle: "p-2",
      role: "user",
      root: (await Identity.fromPassphrase("member root")).did(),
    });
    await elsewhere.recordChain(
      did as `did:key:${string}`,
      await issueIndexChain({
        issuer: await Identity.fromPassphrase("another root"),
        to: did as `did:key:${string}`,
        held: [],
      }),
    );
    const foreign = await callHelper(
      directory,
      baseUrl,
      { op: "chain" },
      `${directory}/identity.key`,
      `${directory}/other`,
    );
    expect(JSON.parse(foreign.stdout)).toMatchObject({
      ok: false,
      status: 409,
    });

    const unstored = await callHelper(directory, baseUrl, { op: "chain" });
    expect(JSON.parse(unstored.stdout)).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(calls).toEqual([]);
  });

  it("presents no chain without a membership store", async () => {
    await callHelper(directory, baseUrl, { op: "search", text: "test" });

    expect(calls[0].body).not.toHaveProperty("proofs");
  });

  it("exits 2 with usage on stderr when a required flag is empty", async () => {
    const output = await callHelper(directory, "", { op: "search" });

    expect(output.code).toBe(2);
    expect(output.stdout).toBe("");
    expect(output.stderr).toContain("usage: cli.ts");
    expect(calls).toEqual([]);
  });
});
