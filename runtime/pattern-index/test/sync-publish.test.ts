import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { verifyFirstPartyHttpRequest } from "@commonfabric/runner/toolshed-http-auth";
import type { RepoSyncPlan } from "../src/repo-sync.ts";

const root = fromFileUrl(new URL("../../../", import.meta.url));
const entry = fromFileUrl(new URL("../sync-publish.ts", import.meta.url));
const decoder = new TextDecoder();

interface IndexCall {
  fn: string;
  did: string;
  body: Record<string, unknown>;
}

const PLAN: RepoSyncPlan = {
  entries: [
    {
      path: "patterns/a/main.tsx",
      status: "compiled",
      sourceHash: "hash-a",
      request: {
        patternId: "id-a",
        description: "Doubles a number.",
        hashtags: ["math"],
        program: {
          main: "/a/main.tsx",
          files: [{ name: "/a/main.tsx", contents: "export default 1;" }],
        },
      },
    },
    { path: "patterns/b/main.tsx", status: "undescribed" },
  ],
  selected: ["patterns/a/main.tsx", "patterns/b/main.tsx"],
};

describe("sync-publish", () => {
  let directory: string;
  let server: Deno.HttpServer<Deno.NetAddr>;
  let origin: string;
  let calls: IndexCall[];
  let audiences: string[];
  let reply: (call: IndexCall) => Response;

  /** Runs the publish step with the grants the action gives it. */
  const runPublish = async (
    args: readonly string[],
    env: Record<string, string> = {
      ACTIONS_ID_TOKEN_REQUEST_URL: `${origin}/oidc`,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runtime-token",
    },
  ) => {
    const output = await new Deno.Command(Deno.execPath(), {
      cwd: directory,
      args: [
        "run",
        "--no-lock",
        "--config",
        `${root}/deno.jsonc`,
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-net=127.0.0.1",
        entry,
        ...args,
      ],
      env,
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      code: output.code,
      stdout: decoder.decode(output.stdout),
      stderr: decoder.decode(output.stderr),
    };
  };

  /** The flags of a publish run against the fake index, given the plan. */
  const publishArgs = async (plan: unknown) => {
    await Deno.writeTextFile(`${directory}/plan.json`, JSON.stringify(plan));
    return [
      "--plan",
      `${directory}/plan.json`,
      "--repository",
      "acme/patterns",
      "--commit",
      "c0ffee",
      "--index-url",
      `${origin}/index`,
      "--summary",
      `${directory}/summary.md`,
    ];
  };

  beforeEach(() => {
    directory = Deno.makeTempDirSync({ prefix: "pattern-index-sync-" });
    calls = [];
    audiences = [];
    reply = (call) =>
      call.fn === "listRepoHeads"
        ? Response.json({
          heads: [{
            path: "patterns/gone.tsx",
            patternId: "id-gone",
            sourceHash: "old",
            commit: "beef",
          }],
        })
        : call.fn === "withdrawRepoPaths"
        ? Response.json({
          withdrawn: [{ path: "patterns/gone.tsx", withdrawn: true }],
        })
        : Response.json({ patternId: call.body.patternId, created: true });
    server = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen() {} },
      async (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/oidc") {
          audiences.push(url.searchParams.get("audience") ?? "");
          return Response.json({ value: "oidc-token" });
        }
        const { userDid } = await verifyFirstPartyHttpRequest({ request });
        const call = {
          fn: url.pathname.split("/").at(-1)!,
          did: userDid,
          body: await request.json(),
        };
        calls.push(call);
        return reply(call);
      },
    );
    origin = `http://127.0.0.1:${server.addr.port}`;
  });

  afterEach(async () => {
    await server.shutdown();
    await Deno.remove(directory, { recursive: true });
  });

  it("publishes the plan's changed entries and withdraws lost paths, each call carrying a token for its signer", async () => {
    const output = await runPublish(await publishArgs(PLAN));

    expect(output.code).toBe(0);
    expect(calls.map((call) => call.fn)).toEqual([
      "listRepoHeads",
      "publishPattern",
      "withdrawRepoPaths",
    ]);
    expect(calls[1].body.source).toEqual({
      repository: "acme/patterns",
      path: "patterns/a/main.tsx",
      commit: "c0ffee",
      sourceHash: "hash-a",
    });
    expect(calls.every((call) => call.body.githubOidc === "oidc-token"))
      .toBe(true);
    expect(audiences).toEqual(
      calls.map((call) =>
        `pattern-index:127.0.0.1:${server.addr.port}:${call.did}`
      ),
    );
    const summary = await Deno.readTextFile(`${directory}/summary.md`);
    expect(summary).toContain("1 published");
    expect(summary).toContain("- `patterns/gone.tsx`");
  });

  it("exits 1 after reporting when an entry failed", async () => {
    reply = (call) =>
      call.fn === "listRepoHeads"
        ? Response.json({ heads: [] })
        : Response.json({ error: "over the daily cap" }, { status: 429 });

    const output = await runPublish(await publishArgs(PLAN));

    expect(output.code).toBe(1);
    expect(await Deno.readTextFile(`${directory}/summary.md`)).toContain(
      "### Failed",
    );
  });

  it("exits 0 after reporting when the index refuses an entry as too large", async () => {
    reply = (call) =>
      call.fn === "listRepoHeads"
        ? Response.json({ heads: [] })
        : Response.json(
          { error: "program exceeds 819200 bytes of source" },
          { status: 400 },
        );

    const output = await runPublish(await publishArgs(PLAN));

    expect(output.code).toBe(0);
    const summary = await Deno.readTextFile(`${directory}/summary.md`);
    expect(summary).toContain("### Not published: too large for the index");
    expect(summary).toContain("- `patterns/a/main.tsx`");
    expect(summary).not.toContain("### Failed");
  });

  it("exits 1 after reporting when the index refuses an entry for another reason", async () => {
    reply = (call) =>
      call.fn === "listRepoHeads"
        ? Response.json({ heads: [] })
        : Response.json({ error: "malformed request" }, { status: 400 });

    const output = await runPublish(await publishArgs(PLAN));

    expect(output.code).toBe(1);
    expect(await Deno.readTextFile(`${directory}/summary.md`)).toContain(
      "### Failed",
    );
  });

  it("exits 1, contacting no index, for a plan of the wrong shape", async () => {
    const output = await runPublish(await publishArgs({ entries: "none" }));

    expect(output.code).toBe(1);
    expect(calls).toEqual([]);
    expect(await Deno.readTextFile(`${directory}/summary.md`)).toContain(
      "Unreadable plan: the plan has no list of entries",
    );
  });

  it("exits 1, contacting no index, in a job that cannot mint a token", async () => {
    const output = await runPublish(await publishArgs(PLAN), {});

    expect(output.code).toBe(1);
    expect(calls).toEqual([]);
    expect(output.stdout).toContain("id-token: write");
  });

  it("exits 2 without --plan, --repository or --commit", async () => {
    const output = await runPublish(["--plan", "plan.json"]);

    expect(output.code).toBe(2);
    expect(output.stderr).toContain("are required");
  });
});
