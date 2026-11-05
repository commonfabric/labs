// Drives `cf inspect … --remote` in-process against a stubbed fetch, so the CLI
// remote plumbing (base-url resolution, CF1 signing, remote DID resolution,
// fetch+cache, and the spaces/pull/summary/converge actions) is actually
// exercised — no live server needed. `main.parse` re-throws action errors, so
// error paths are asserted with assertRejects.

import { afterAll, afterEach, beforeAll, describe, it } from "@std/testing/bdd";
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { Database } from "@db/sqlite";
import { ValidationError } from "@cliffy/command";
import { Identity } from "@commonfabric/identity";
import { defaultCacheDir } from "@commonfabric/state-inspector";
import type { FabricValue } from "@commonfabric/data-model";
import { jsonFromFabricValue } from "@commonfabric/data-model/codecs";
import { inspect } from "../commands/inspect.ts";

const DUMP_BASE = "/api/storage/memory/dump";
const BASE = "http://cli-remote-test.invalid:9999";
const DID_A = "did:key:z6MkCliRemoteTestSpaceAAAAAAAAAAAAAAAAAAAAAAAAAA";
const DID_B = "did:key:z6MkCliRemoteTestSpaceBBBBBBBBBBBBBBBBBBBBBBBBBB";
const VIEWER_DID = "did:key:zInspector";
const VIEWER_SESSION = "viewer-session";

// Minimal valid memory-v2 space DB (schema mirrors state-inspector/test/cli.test.ts).
const SCHEMA = `
CREATE TABLE "commit" (
  seq INTEGER NOT NULL PRIMARY KEY, branch TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL, local_seq INTEGER NOT NULL,
  invocation_ref TEXT, authorization_ref TEXT,
  original JSON NOT NULL, resolution JSON NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE revision (
  branch TEXT NOT NULL DEFAULT '', id TEXT NOT NULL,
  scope_key TEXT NOT NULL DEFAULT 'space', seq INTEGER NOT NULL,
  op_index INTEGER NOT NULL, op TEXT NOT NULL, data JSON, commit_seq INTEGER NOT NULL,
  PRIMARY KEY (branch, id, scope_key, seq, op_index)
);
CREATE TABLE branch (
  name TEXT NOT NULL PRIMARY KEY DEFAULT '', parent_branch TEXT,
  fork_seq INTEGER, created_seq INTEGER NOT NULL DEFAULT 0,
  head_seq INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active'
);
INSERT INTO branch (name, head_seq, status) VALUES ('', 2, 'active');
`;

let dbBytes: Uint8Array;
let keyPath: string;
let tmpRoot: string;
const realFetch = globalThis.fetch;
const prevIdentity = Deno.env.get("CF_IDENTITY");
const prevApiUrl = Deno.env.get("CF_API_URL");

async function buildDbBytes(): Promise<Uint8Array> {
  const dir = await Deno.makeTempDir({ prefix: "cli-remote-seed-" });
  const path = `${dir}/space.sqlite`;
  const db = new Database(path, { create: true });
  db.exec(SCHEMA);
  let deep: FabricValue = { leaf: "complete" };
  for (let depth = 0; depth < 12; depth++) deep = { child: deep };
  db.prepare(
    `INSERT INTO "commit" (seq, session_id, local_seq, original, resolution)
     VALUES (1, 'session:did:key:zX:u', 1, '{"reads":{"confirmed":[],"pending":[]}}', '{}')`,
  ).run();
  db.prepare(
    `INSERT INTO revision (id, seq, op_index, op, data, commit_seq)
     VALUES ('of:a', 1, 0, 'set', ?, 1)`,
  ).run(jsonFromFabricValue({
    value: {
      n: 1,
      deep,
      "a/b": "literal slash key",
      a: { b: "nested keys" },
      "": "empty key",
      items: ["zero", "one"],
      "(root)": "reserved-looking key",
      "line\nforged": "\u001b[2Jforged\nline",
      "bidi\u202Eforged": "bidi one",
      collision: undefined,
    },
  }));
  db.prepare(
    `INSERT INTO revision
       (id, scope_key, seq, op_index, op, data, commit_seq)
     VALUES ('of:a', 'user:did%3Akey%3AzInspector', 1, 0, 'set', ?, 1)`,
  ).run(jsonFromFabricValue({
    value: {
      n: 2,
      deep,
      "a/b": "identity slash key",
      "": "identity empty key",
      nested: { leaf: "identity nested key" },
    },
  }));
  db.prepare(
    `INSERT INTO revision
       (id, scope_key, seq, op_index, op, data, commit_seq)
     VALUES ('of:a', 'session:did%3Akey%3AzInspector:viewer-session', 1, 0, 'set', ?, 1)`,
  ).run(JSON.stringify({
    value: { "a/b": "session slash key" },
  }));
  db.prepare(
    `INSERT INTO "commit" (seq, session_id, local_seq, original, resolution)
     VALUES (2, 'session:did:key:zX:u', 2, '{"reads":{"confirmed":[],"pending":[]}}', '{}')`,
  ).run();
  db.prepare(
    `INSERT INTO revision (id, seq, op_index, op, data, commit_seq)
     VALUES ('of:a', 2, 0, 'set', ?, 2)`,
  ).run(jsonFromFabricValue({
    value: {
      n: 1,
      deep,
      "a/b": "literal slash key changed",
      a: { b: "nested keys changed" },
      "": "empty key changed",
      items: ["zero", "one"],
      "(root)": "reserved-looking key changed",
      "line\nforged": "\u001b[31mother\rline",
      "bidi\u202Eforged": "bidi two",
      collision: { $undefined: true },
    },
  }));
  db.close();
  const bytes = await Deno.readFile(path);
  await Deno.remove(dir, { recursive: true });
  return bytes;
}

interface StubOpts {
  status?: number;
  spaces?: { space: string; sizeBytes: number; mtimeMs: number }[];
}
interface StubState {
  requests: number;
}

function stubFetch(opts: StubOpts = {}): StubState {
  const state: StubState = { requests: 0 };
  const spaces = opts.spaces ??
    [{ space: DID_A, sizeBytes: dbBytes.length, mtimeMs: 1 }];
  globalThis.fetch = ((input: string | URL | Request) => {
    state.requests++;
    const url = new URL(typeof input === "string" ? input : input.toString());
    if (opts.status && opts.status !== 200) {
      return Promise.resolve(
        new Response(JSON.stringify({ error: "denied" }), {
          status: opts.status,
        }),
      );
    }
    if (url.pathname === DUMP_BASE) {
      return Promise.resolve(
        new Response(JSON.stringify({ spaces }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    if (url.pathname.startsWith(`${DUMP_BASE}/`)) {
      // deno-lint-ignore no-explicit-any
      return Promise.resolve(new Response(dbBytes as any, { status: 200 }));
    }
    return Promise.resolve(new Response("nope", { status: 404 }));
  }) as typeof fetch;
  return state;
}

/** Run a subcommand, capturing stdout. */
async function run(argv: string[]): Promise<string> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  try {
    await inspect.parse(argv);
    return lines.join("\n");
  } finally {
    console.log = orig;
  }
}

async function clearCache(): Promise<void> {
  await Deno.remove(defaultCacheDir(BASE), { recursive: true }).catch(() => {});
}

beforeAll(async () => {
  dbBytes = await buildDbBytes();
  tmpRoot = await Deno.makeTempDir({ prefix: "cli-remote-key-" });
  keyPath = `${tmpRoot}/id.key`;
  await Deno.writeFile(keyPath, await Identity.generatePkcs8());
  Deno.env.set("CF_IDENTITY", keyPath);
  Deno.env.delete("CF_API_URL");
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  await clearCache();
});

afterAll(async () => {
  if (prevIdentity === undefined) Deno.env.delete("CF_IDENTITY");
  else Deno.env.set("CF_IDENTITY", prevIdentity);
  if (prevApiUrl === undefined) Deno.env.delete("CF_API_URL");
  else Deno.env.set("CF_API_URL", prevApiUrl);
  await Deno.remove(tmpRoot, { recursive: true }).catch(() => {});
});

describe("cf inspect --remote", () => {
  it("spaces --remote lists what the server exposes", async () => {
    stubFetch({ spaces: [{ space: DID_A, sizeBytes: 10, mtimeMs: 1 }] });
    const out = await run(["spaces", "--remote", BASE, "--json"]);
    const parsed = JSON.parse(out);
    assertEquals(parsed.remote, BASE);
    assertEquals(parsed.spaces[0].space, DID_A);
  });

  it("bare --remote falls back to CF_API_URL", async () => {
    stubFetch();
    Deno.env.set("CF_API_URL", BASE);
    try {
      const out = await run(["spaces", "--remote", "--json"]);
      assertEquals(JSON.parse(out).remote, BASE);
    } finally {
      Deno.env.delete("CF_API_URL");
    }
  });

  it("bare --remote with no CF_API_URL errors", async () => {
    stubFetch();
    await assertRejects(
      () => run(["spaces", "--remote", "--json"]),
      Error,
      "CF_API_URL",
    );
  });

  it("pull <did> caches the snapshot with a literal-DID filename", async () => {
    stubFetch();
    const out = await run(["pull", DID_A, "--remote", BASE, "--json"]);
    const parsed = JSON.parse(out);
    assertEquals(parsed.pulled[0].did, DID_A);
    assertStringIncludes(parsed.pulled[0].path, `${DID_A}.sqlite`);
    assertEquals(parsed.pulled[0].path.includes("%3A"), false);
  });

  it("pull --all pulls every listed space", async () => {
    stubFetch({
      spaces: [
        { space: DID_A, sizeBytes: 10, mtimeMs: 2 },
        { space: DID_B, sizeBytes: 10, mtimeMs: 1 },
      ],
    });
    const out = await run(["pull", "--all", "--remote", BASE, "--json"]);
    const dids = JSON.parse(out).pulled.map((p: { did: string }) => p.did);
    assertEquals(dids.sort(), [DID_A, DID_B].sort());
  });

  it("pull without --remote is an error", async () => {
    await assertRejects(
      () => run(["pull", DID_A, "--json"]),
      Error,
      "requires --remote",
    );
  });

  it("summary --remote fetches, caches, and inspects a full DID", async () => {
    stubFetch();
    const out = await run(["summary", DID_A, "--remote", BASE, "--json"]);
    const s = JSON.parse(out);
    assertEquals(s.commits, 2);
    assertEquals(s.entities, 1);
  });

  it("preserves every nested value with `value-at --full-depth`", async () => {
    stubFetch();
    const shallow = JSON.parse(
      await run([
        "value-at",
        DID_A,
        "of:a",
        "--remote",
        BASE,
        "--json",
      ]),
    );
    expect(JSON.stringify(shallow.value.deep)).toContain('"…"');

    const full = JSON.parse(
      await run([
        "value-at",
        DID_A,
        "of:a",
        "--remote",
        BASE,
        "--full-depth",
        "--json",
      ]),
    );
    let nested = full.value.deep;
    for (let depth = 0; depth < 12; depth++) nested = nested.child;
    expect(nested).toEqual({ leaf: "complete" });

    const identityView = JSON.parse(
      await run([
        "value-at",
        DID_A,
        "of:a",
        "--remote",
        BASE,
        "--as",
        VIEWER_DID,
        "--full-depth",
        "--json",
      ]),
    );
    expect(identityView.resolvedKind).toBe("user");
    nested = identityView.value.deep;
    for (let depth = 0; depth < 12; depth++) nested = nested.child;
    expect(nested).toEqual({ leaf: "complete" });
  });

  it("value-at applies exact and slash paths to identity views", async () => {
    stubFetch();
    const identityPath = JSON.parse(
      await run([
        "value-at",
        DID_A,
        "of:a",
        "--remote",
        BASE,
        "--as",
        VIEWER_DID,
        "--path-json",
        '["a/b"]',
        "--json",
      ]),
    );
    assertEquals(identityPath.resolvedKind, "user");
    assertEquals(identityPath.pathExists, true);
    assertEquals(identityPath.value, "identity slash key");

    const identitySlashPath = JSON.parse(
      await run([
        "value-at",
        DID_A,
        "of:a",
        "--remote",
        BASE,
        "--as",
        VIEWER_DID,
        "--path",
        "nested/leaf",
        "--json",
      ]),
    );
    assertEquals(identitySlashPath.resolvedKind, "user");
    assertEquals(identitySlashPath.value, "identity nested key");

    const primitivePath = JSON.parse(
      await run([
        "value-at",
        DID_A,
        "of:a",
        "--remote",
        BASE,
        "--as",
        VIEWER_DID,
        "--path",
        "nested/leaf/length",
        "--json",
      ]),
    );
    assertEquals(primitivePath.resolvedKind, "user");
    assertEquals(primitivePath.pathExists, true);
    assertEquals(primitivePath.value, 19);

    const sessionPath = JSON.parse(
      await run([
        "value-at",
        DID_A,
        "of:a",
        "--remote",
        BASE,
        "--as",
        VIEWER_DID,
        "--session",
        VIEWER_SESSION,
        "--path-json",
        '["a/b"]',
        "--json",
      ]),
    );
    assertEquals(sessionPath.resolvedKind, "session");
    assertEquals(sessionPath.pathExists, true);
    assertEquals(sessionPath.value, "session slash key");

    const identityDocument = JSON.parse(
      await run([
        "value-at",
        DID_A,
        "of:a",
        "--remote",
        BASE,
        "--as",
        VIEWER_DID,
        "--doc",
        "--json",
      ]),
    );
    assertEquals(identityDocument.resolvedKind, "user");
    assertEquals(identityDocument.value.value["a/b"], "identity slash key");
  });

  it("value-at --path-json preserves exact and root paths", async () => {
    stubFetch();
    const slash = JSON.parse(
      await run([
        "value-at",
        DID_A,
        "of:a",
        "--remote",
        BASE,
        "--path-json",
        '["a/b"]',
        "--json",
      ]),
    );
    assertEquals(slash.pathExists, true);
    assertEquals(slash.value, "literal slash key changed");

    const empty = JSON.parse(
      await run([
        "value-at",
        DID_A,
        "of:a",
        "--remote",
        BASE,
        "--path-json",
        '[""]',
        "--json",
      ]),
    );
    assertEquals(empty.pathExists, true);
    assertEquals(empty.value, "empty key changed");

    const root = JSON.parse(
      await run([
        "value-at",
        DID_A,
        "of:a",
        "--remote",
        BASE,
        "--path-json",
        "[]",
        "--json",
      ]),
    );
    assertEquals(root.pathExists, true);
    assertEquals(root.value.n, 1);
  });

  it("value-at does not coerce array segments", async () => {
    stubFetch();
    const result = JSON.parse(
      await run([
        "value-at",
        DID_A,
        "of:a",
        "--remote",
        BASE,
        "--path-json",
        '["items","01"]',
        "--json",
      ]),
    );
    assertEquals(result.pathExists, false);
    assertEquals(result.value, { $undefined: true });

    const slashResult = JSON.parse(
      await run([
        "value-at",
        DID_A,
        "of:a",
        "--remote",
        BASE,
        "--path",
        "items/01",
        "--json",
      ]),
    );
    assertEquals(slashResult.pathExists, false);
  });

  it("diff preserves exact input and result path segments", async () => {
    stubFetch();
    const result = JSON.parse(
      await run([
        "diff",
        DID_A,
        "of:a",
        "--remote",
        BASE,
        "--from",
        "1",
        "--to",
        "2",
        "--json",
      ]),
    );
    assertEquals(
      result.changes.map((change: { pathSegments: string[] }) =>
        JSON.stringify(change.pathSegments)
      ).sort(),
      [
        ["a/b"],
        ["a", "b"],
        [""],
        ["(root)"],
        ["line\nforged"],
        ["bidi\u202Eforged"],
        ["collision"],
      ].map((segments) => JSON.stringify(segments)).sort(),
    );
    const collision = result.changes.find(
      (change: { pathSegments: string[] }) =>
        change.pathSegments.length === 1 &&
        change.pathSegments[0] === "collision",
    );
    assertEquals(collision, {
      path: "collision",
      pathSegments: ["collision"],
      kind: "changed",
      before: { $undefined: true },
      beforeIsUndefined: true,
      after: { $undefined: true },
      annotationCollision: true,
      beforeValueKind: "undefined",
      afterValueKind: "object",
    });

    const focused = JSON.parse(
      await run([
        "diff",
        DID_A,
        "of:a",
        "--remote",
        BASE,
        "--from",
        "1",
        "--to",
        "2",
        "--path-json",
        '["a/b"]',
        "--json",
      ]),
    );
    assertEquals(focused.changes, [{
      path: "",
      pathSegments: [],
      kind: "changed",
      before: "literal slash key",
      after: "literal slash key changed",
    }]);

    const document = JSON.parse(
      await run([
        "diff",
        DID_A,
        "of:a",
        "--remote",
        BASE,
        "--from",
        "1",
        "--to",
        "2",
        "--doc",
        "--json",
      ]),
    );
    const documentChange = document.changes.find(
      (change: { pathSegments: string[] }) =>
        JSON.stringify(change.pathSegments) ===
          JSON.stringify(["value", "a/b"]),
    );
    assertEquals(documentChange, {
      path: "value/a/b",
      pathSegments: ["value", "a/b"],
      kind: "changed",
      before: "literal slash key",
      after: "literal slash key changed",
    });

    const human = await run([
      "diff",
      DID_A,
      "of:a",
      "--remote",
      BASE,
      "--from",
      "1",
      "--to",
      "2",
    ]);
    assertStringIncludes(human, '["a/b"]');
    assertStringIncludes(human, "  ~ a/b:");
    assertStringIncludes(human, '[""]');
    assertStringIncludes(human, '["(root)"]');
    assertStringIncludes(human, '["line\\nforged"]');
    assertStringIncludes(human, '["bidi\\u202eforged"]');
    assertStringIncludes(
      human,
      "  ~ collision: undefined [undefined] → {$undefined} [object] " +
        "(display annotations match)",
    );
    assertStringIncludes(human, '"\\u001b[2Jforged\\nline"');
    assertStringIncludes(human, '"\\u001b[31mother\\rline"');
    assertEquals(human.includes("\u001b"), false);
  });

  it("value-at rejects ambiguous or invalid exact paths", async () => {
    stubFetch();
    await assertRejects(
      () =>
        run([
          "value-at",
          DID_A,
          "of:a",
          "--remote",
          BASE,
          "--path",
          "a/b",
          "--path-json",
          '["a/b"]',
          "--json",
        ]),
      ValidationError,
      "either `--path` or `--path-json`",
    );
    await assertRejects(
      () =>
        run([
          "value-at",
          DID_A,
          "of:a",
          "--remote",
          BASE,
          "--path-json",
          '["a/b",0]',
          "--json",
        ]),
      ValidationError,
      "JSON array of string segments",
    );
    await assertRejects(
      () =>
        run([
          "value-at",
          DID_A,
          "of:a",
          "--remote",
          BASE,
          "--doc",
          "--path-json",
          '["a/b"]',
          "--json",
        ]),
      ValidationError,
      "`--doc` without `--path` or `--path-json`",
    );
  });

  it("value-at rejects selectors that cannot affect its view", async () => {
    const fetchState = stubFetch();
    await assertRejects(
      () =>
        run([
          "value-at",
          DID_A,
          "of:a",
          "--remote",
          BASE,
          "--as",
          VIEWER_DID,
          "--scope",
          "space",
          "--json",
        ]),
      ValidationError,
      "either `--as` or `--scope`",
    );
    await assertRejects(
      () =>
        run([
          "value-at",
          DID_A,
          "of:a",
          "--remote",
          BASE,
          "--session",
          VIEWER_SESSION,
          "--json",
        ]),
      ValidationError,
      "`--session` requires `--as`",
    );
    await assertRejects(
      () =>
        run([
          "value-at",
          DID_A,
          "of:a",
          "--remote",
          BASE,
          "--as",
          "",
          "--json",
        ]),
      ValidationError,
      'Missing value for option "--as"',
    );
    await assertRejects(
      () =>
        run([
          "value-at",
          DID_A,
          "of:a",
          "--remote",
          BASE,
          "--as",
          VIEWER_DID,
          "--session",
          "",
          "--json",
        ]),
      ValidationError,
      'Missing value for option "--session"',
    );
    assertEquals(fetchState.requests, 0);
  });

  it("resolveRemoteDid: a unique prefix resolves via the remote list", async () => {
    stubFetch({ spaces: [{ space: DID_A, sizeBytes: 10, mtimeMs: 1 }] });
    const out = await run([
      "summary",
      "z6MkCliRemoteTestSpaceA",
      "--remote",
      BASE,
      "--json",
    ]);
    assertEquals(JSON.parse(out).entities, 1);
  });

  it("resolveRemoteDid: a did:-prefixed PREFIX resolves like any prefix", async () => {
    // Regression: a partial DID (`did:key:z6Mk…` copied short) used to be sent
    // verbatim and 404 instead of prefix-resolving against the remote listing.
    stubFetch({ spaces: [{ space: DID_A, sizeBytes: 10, mtimeMs: 1 }] });
    const out = await run([
      "summary",
      DID_A.slice(0, 20), // "did:key:z6MkCliRemot"
      "--remote",
      BASE,
      "--json",
    ]);
    assertEquals(JSON.parse(out).entities, 1);
  });

  it("resolveRemoteDid: an ambiguous token errors", async () => {
    stubFetch({
      spaces: [
        { space: DID_A, sizeBytes: 10, mtimeMs: 2 },
        { space: DID_B, sizeBytes: 10, mtimeMs: 1 },
      ],
    });
    await assertRejects(
      () =>
        run(["summary", "z6MkCliRemoteTestSpace", "--remote", BASE, "--json"]),
      Error,
      "ambiguous",
    );
  });

  it("a 401 from the server surfaces an actionable error", async () => {
    stubFetch({ status: 401 });
    await assertRejects(
      () => run(["spaces", "--remote", BASE, "--json"]),
      Error,
      "CF_IDENTITY",
    );
  });

  it("converge --spaces over --remote reconstructs across fetched DBs", async () => {
    stubFetch({
      spaces: [
        { space: DID_A, sizeBytes: 10, mtimeMs: 2 },
        { space: DID_B, sizeBytes: 10, mtimeMs: 1 },
      ],
    });
    const out = await run([
      "converge",
      "of:a",
      "--spaces",
      `${DID_A},${DID_B}`,
      "--remote",
      BASE,
      "--json",
    ]);
    assertEquals(JSON.parse(out).id, "of:a");
  });

  it("converge preserves exact path segments", async () => {
    stubFetch({
      spaces: [
        { space: DID_A, sizeBytes: 10, mtimeMs: 2 },
        { space: DID_B, sizeBytes: 10, mtimeMs: 1 },
      ],
    });
    const result = JSON.parse(
      await run([
        "converge",
        "of:a",
        "--spaces",
        `${DID_A},${DID_B}`,
        "--remote",
        BASE,
        "--path-json",
        '["a/b"]',
        "--json",
      ]),
    );
    assertEquals(result.path, ["a/b"]);
    assertEquals(
      result.views.map((view: { value: unknown }) => view.value),
      ["literal slash key changed", "literal slash key changed"],
    );

    const exactHuman = await run([
      "converge",
      "of:a",
      "--spaces",
      `${DID_A},${DID_B}`,
      "--remote",
      BASE,
      "--path-json",
      '["a/b"]',
    ]);
    assertStringIncludes(exactHuman, 'path=["a/b"]');

    const legacyHuman = await run([
      "converge",
      "of:a",
      "--spaces",
      `${DID_A},${DID_B}`,
      "--remote",
      BASE,
      "--path",
      "a/b",
    ]);
    assertStringIncludes(legacyHuman, "path=/a/b");

    const unsafeLegacyHuman = await run([
      "converge",
      "of:a",
      "--spaces",
      `${DID_A},${DID_B}`,
      "--remote",
      BASE,
      "--path",
      "line\nforged",
    ]);
    assertStringIncludes(unsafeLegacyHuman, 'path=["line\\nforged"]');
    assertEquals(unsafeLegacyHuman.includes("path=/line\nforged"), false);
  });

  it("converge --all over --remote uses the remote listing", async () => {
    stubFetch({
      spaces: [
        { space: DID_A, sizeBytes: 10, mtimeMs: 2 },
        { space: DID_B, sizeBytes: 10, mtimeMs: 1 },
      ],
    });
    const out = await run([
      "converge",
      "of:a",
      "--all",
      "--remote",
      BASE,
      "--json",
    ]);
    assertEquals(JSON.parse(out).id, "of:a");
  });

  it("converge rejects conflicting selectors before remote I/O", async () => {
    const fetchState = stubFetch();
    await assertRejects(
      () =>
        run([
          "converge",
          "of:a",
          "--all",
          "--spaces",
          DID_A,
          "--remote",
          BASE,
          "--json",
        ]),
      ValidationError,
      "only one",
    );
    assertEquals(fetchState.requests, 0);
  });

  it("converge rejects a local directory in remote mode before I/O", async () => {
    const fetchState = stubFetch();
    await assertRejects(
      () =>
        run([
          "converge",
          "of:a",
          "--dir",
          tmpRoot,
          "--remote",
          BASE,
          "--json",
        ]),
      ValidationError,
      "cannot be used",
    );
    assertEquals(fetchState.requests, 0);
  });

  it("converge validates a missing selector before identity I/O", async () => {
    const fetchState = stubFetch();
    await assertRejects(
      () =>
        run([
          "converge",
          "of:a",
          "--remote",
          BASE,
          "--identity",
          `${tmpRoot}/missing.key`,
          "--json",
        ]),
      ValidationError,
      "Use one of",
    );
    assertEquals(fetchState.requests, 0);
  });

  it("converge rejects an empty spaces list before identity I/O", async () => {
    const fetchState = stubFetch();
    await assertRejects(
      () =>
        run([
          "converge",
          "of:a",
          "--spaces",
          " , ",
          "--remote",
          BASE,
          "--identity",
          `${tmpRoot}/missing.key`,
          "--json",
        ]),
      ValidationError,
      "must contain at least one space",
    );
    assertEquals(fetchState.requests, 0);
  });

  it("resolveRemoteDid: a token matching nothing errors", async () => {
    stubFetch({ spaces: [{ space: DID_A, sizeBytes: 10, mtimeMs: 1 }] });
    await assertRejects(
      () => run(["summary", "zNoSuchSpaceXYZ", "--remote", BASE, "--json"]),
      Error,
      "no remote space matches",
    );
  });

  it("no CF_IDENTITY sends an unsigned request (server would 401)", async () => {
    stubFetch();
    Deno.env.delete("CF_IDENTITY");
    try {
      // Stub accepts it; the point is remoteSigner returns undefined and the
      // request still goes out (real server replies 401 — see 401 test above).
      const out = await run(["spaces", "--remote", BASE, "--json"]);
      assertEquals(JSON.parse(out).remote, BASE);
    } finally {
      Deno.env.set("CF_IDENTITY", keyPath);
    }
  });

  it("without --remote, a command opens a local DB by path", async () => {
    const dir = await Deno.makeTempDir({ prefix: "cli-remote-local-" });
    const path = `${dir}/space.sqlite`;
    try {
      await Deno.writeFile(path, dbBytes);
      const out = await run(["summary", path, "--json"]);
      assertEquals(JSON.parse(out).entities, 1);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
});
