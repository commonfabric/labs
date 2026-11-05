import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  AGENTS_HOST_CONFIG_SCHEMA,
  DEFAULT_COLLECTION_INTERVAL_MS,
  loadAgentsHostConfig,
  MAX_COLLECTION_INTERVAL_MS,
  parseAgentsHostConfig,
} from "../src/config.ts";
import { parseAgentsHostCliOptions } from "../src/cli-options.ts";
import { basename, join } from "@std/path";
import { Identity } from "@commonfabric/identity";
import { assertConfiguredOwner } from "../src/fabric-runtime.ts";

Deno.test("configured owner must match the signing identity", async () => {
  const owner = await Identity.fromPassphrase("agents host configured owner");
  const other = await Identity.fromPassphrase("agents host other owner");
  assertConfiguredOwner(owner, owner.did());
  assertThrows(
    () => assertConfiguredOwner(owner, other.did()),
    Error,
    "does not match identity",
  );
});

Deno.test("parseAgentsHostConfig validates and preserves provider options", () => {
  const config = parseAgentsHostConfig({
    schema: AGENTS_HOST_CONFIG_SCHEMA,
    ownerDid: "did:key:test-owner",
    collectionIntervalMs: 1_234,
    checkoutRoots: ["/workspace/checkouts"],
    sources: [
      {
        id: "codex-work",
        driver: "codex-app-server",
        enabled: true,
        codexTransport: "proxy",
        codexSocket: " /tmp/codex.sock ",
        cwd: " /work ",
        command: ["codex", " --profile ", "work"],
        env: { PROFILE: "work" },
        allowDangerFullAccess: false,
      },
      {
        id: "acp-local",
        driver: "acp",
        enabled: false,
      },
    ],
  });

  assertEquals(config.ownerDid, "did:key:test-owner");
  assertEquals(config.collectionIntervalMs, 1_234);
  assertEquals(config.checkoutRoots, ["/workspace/checkouts"]);
  assertEquals(config.sources, [
    {
      id: "codex-work",
      driver: "codex-app-server",
      enabled: true,
      codexTransport: "proxy",
      codexSocket: " /tmp/codex.sock ",
      cwd: " /work ",
      command: ["codex", " --profile ", "work"],
      env: { PROFILE: "work" },
      allowDangerFullAccess: false,
    },
    {
      id: "acp-local",
      driver: "acp",
      enabled: false,
    },
  ]);
});

Deno.test("parseAgentsHostConfig validates checkout search roots", () => {
  for (
    const checkoutRoots of [
      "/workspace/checkouts",
      ["relative"],
      ["/workspace/checkouts", "/workspace/checkouts"],
    ]
  ) {
    assertThrows(
      () =>
        parseAgentsHostConfig({
          schema: AGENTS_HOST_CONFIG_SCHEMA,
          ownerDid: "did:key:test-owner",
          checkoutRoots,
          sources: [{
            id: "codex",
            driver: "codex-app-server",
            enabled: true,
          }],
        }),
      Error,
    );
  }
});

Deno.test("parseAgentsHostConfig rejects a non-DID owner", () => {
  assertThrows(
    () =>
      parseAgentsHostConfig({
        schema: AGENTS_HOST_CONFIG_SCHEMA,
        ownerDid: "not-a-did",
        sources: [{
          id: "codex",
          driver: "codex-app-server",
          enabled: true,
        }],
      }),
    Error,
    "configuration.ownerDid must be a DID",
  );
});

Deno.test("parseAgentsHostConfig rejects malformed boundary fields", () => {
  const source = {
    id: "codex",
    driver: "codex-app-server",
    enabled: true,
  };
  const config = {
    schema: AGENTS_HOST_CONFIG_SCHEMA,
    ownerDid: "did:key:test-owner",
    sources: [source],
  };
  const cases: Array<[unknown, string]> = [
    [null, "configuration must be an object"],
    [{ ...config, extra: true }, "configuration has an unknown field"],
    [{ ...config, schema: "wrong" }, "configuration.schema must be"],
    [{ ...config, sources: [] }, "sources must be a non-empty array"],
    [{ ...config, sources: [null] }, "sources[0] must be an object"],
    [
      { ...config, sources: [{ ...source, command: [] }] },
      "command must be a non-empty string array",
    ],
    [
      { ...config, sources: [{ ...source, env: { BAD: 1 } }] },
      "env.BAD must be a string",
    ],
    [
      { ...config, sources: [{ ...source, extra: true }] },
      "sources[0] has an unknown field",
    ],
    [
      { ...config, sources: [{ ...source, driver: "unknown" }] },
      "driver is not supported",
    ],
    [
      { ...config, sources: [{ ...source, enabled: "yes" }] },
      "enabled must be a boolean",
    ],
    [
      { ...config, sources: [{ ...source, codexTransport: "unknown" }] },
      "codexTransport is not supported",
    ],
    [
      { ...config, sources: [{ ...source, allowDangerFullAccess: "yes" }] },
      "allowDangerFullAccess must be a boolean",
    ],
    [
      { ...config, checkoutRoots: "/workspace" },
      "checkoutRoots must be a string array",
    ],
    [
      { ...config, checkoutRoots: ["/workspace", "/workspace"] },
      "checkoutRoots contains a duplicate path",
    ],
    [{ ...config, sources: [source, source] }, "duplicate source id"],
    [
      { ...config, sources: [{ ...source, enabled: false }] },
      "must enable at least one source",
    ],
  ];
  for (const [value, message] of cases) {
    assertThrows(() => parseAgentsHostConfig(value), Error, message);
  }
});

Deno.test("parseAgentsHostConfig rejects ambiguous source identities", () => {
  assertThrows(
    () =>
      parseAgentsHostConfig({
        schema: AGENTS_HOST_CONFIG_SCHEMA,
        ownerDid: "did:key:test-owner",
        sources: [
          {
            id: "Codex",
            driver: "codex-app-server",
            enabled: true,
          },
        ],
      }),
    Error,
    'sources[0].id must already be normalized as "codex"',
  );
});

Deno.test("parseAgentsHostConfig requires commands for enabled ACP sources", () => {
  assertThrows(
    () =>
      parseAgentsHostConfig({
        schema: AGENTS_HOST_CONFIG_SCHEMA,
        ownerDid: "did:key:test-owner",
        sources: [{ id: "acp", driver: "acp", enabled: true }],
      }),
    Error,
    "sources[0].command is required",
  );
});

Deno.test("loadAgentsHostConfig accepts JSONC", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "agents.jsonc");
  try {
    await Deno.writeTextFile(
      path,
      `{
        // One source is enough for a host.
        "schema": "${AGENTS_HOST_CONFIG_SCHEMA}",
        "ownerDid": "did:key:test-owner",
        "sources": [
          { "id": "claude", "driver": "claude-agent-sdk", "enabled": true }
        ]
      }`,
    );
    const config = await loadAgentsHostConfig(path);
    assertEquals(
      config.collectionIntervalMs,
      DEFAULT_COLLECTION_INTERVAL_MS,
    );
    assertEquals(config.sources[0].id, "claude");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("parseAgentsHostConfig rejects invalid collection intervals", () => {
  for (
    const collectionIntervalMs of [
      null,
      -1,
      1.5,
      "900000",
      MAX_COLLECTION_INTERVAL_MS + 1,
    ]
  ) {
    assertThrows(
      () =>
        parseAgentsHostConfig({
          schema: AGENTS_HOST_CONFIG_SCHEMA,
          ownerDid: "did:key:test-owner",
          collectionIntervalMs,
          sources: [{
            id: "codex",
            driver: "codex-app-server",
            enabled: true,
          }],
        }),
      Error,
      `configuration.collectionIntervalMs must be an integer from 0 through ${MAX_COLLECTION_INTERVAL_MS}`,
    );
  }
});

Deno.test("loadAgentsHostConfig reports a missing file", async () => {
  await assertRejects(
    () => loadAgentsHostConfig("/path/that/does/not/exist/agents.jsonc"),
    Error,
    "configuration file does not exist",
  );
});

Deno.test("loadAgentsHostConfig distinguishes invalid JSONC", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "agents.jsonc");
  try {
    await Deno.writeTextFile(path, "{ invalid");
    await assertRejects(
      () => loadAgentsHostConfig(path),
      Error,
      "configuration file is not valid JSONC",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("parseAgentsHostCliOptions reads connection values from the environment", () => {
  const env: Record<string, string> = {
    CF_API_URL: "http://fabric.example.test",
    CF_IDENTITY: "./operator.key",
    CF_SPACE: "agent-space",
  };
  const options = parseAgentsHostCliOptions(
    ["--config", "./agents.jsonc", "--once", "--no-debug-view"],
    (key) => env[key],
  );
  if (options.help) throw new Error("expected executable options");

  assertEquals(options.apiUrl, env.CF_API_URL);
  assertEquals(basename(options.identityPath), "operator.key");
  assertEquals(options.space, "agent-space");
  assertEquals(options.once, true);
  assertEquals(options.debugView, false);
});

Deno.test("parseAgentsHostCliOptions rejects unknown flags", () => {
  assertThrows(
    () =>
      parseAgentsHostCliOptions(
        ["--config", "agents.jsonc", "--mystery"],
        () => undefined,
      ),
    Error,
    "unknown option: --mystery",
  );
});

Deno.test("parseAgentsHostCliOptions rejects missing and positional values", () => {
  assertThrows(
    () => parseAgentsHostCliOptions([], () => undefined),
    Error,
    "missing required option: --config",
  );
  assertThrows(
    () => parseAgentsHostCliOptions(["unexpected"], () => undefined),
    Error,
    "unexpected positional argument: unexpected",
  );
});

Deno.test("parseAgentsHostCliOptions does not accept per-invocation ledgers", () => {
  assertThrows(
    () =>
      parseAgentsHostCliOptions(
        ["--config", "agents.jsonc", "--ledger", "ledger.json"],
        () => undefined,
      ),
    Error,
    "unknown option: --ledger",
  );
});

Deno.test("parseAgentsHostCliOptions does not expose invalid URL credentials", () => {
  const secret = "credential-that-must-not-appear";
  const error = assertThrows(
    () =>
      parseAgentsHostCliOptions(
        [
          "--config",
          "agents.jsonc",
          "--api-url",
          `https://operator:${secret}@[invalid`,
          "--identity",
          "operator.key",
          "--space",
          "agent-space",
        ],
        () => undefined,
      ),
    Error,
    "--api-url is not a valid URL",
  );
  assertEquals(error.cause, undefined);
  assertEquals(String(error).includes(secret), false);
});

Deno.test("parseAgentsHostConfig accepts normalized command producers and rejects malformed ones", () => {
  const base = {
    schema: AGENTS_HOST_CONFIG_SCHEMA,
    ownerDid: "did:key:test-owner",
    sources: [{ id: "claude", driver: "claude-agent-sdk", enabled: true }],
  };
  assertEquals(
    parseAgentsHostConfig({
      ...base,
      commandProducers: [{ id: "workbench", piece: " fid1:piece " }],
    }).commandProducers,
    [{ id: "workbench", piece: "fid1:piece" }],
  );
  assertEquals(parseAgentsHostConfig(base).commandProducers, undefined);
  assertEquals(
    parseAgentsHostConfig({ ...base, commandProducers: [] }).commandProducers,
    undefined,
  );
  assertThrows(
    () => parseAgentsHostConfig({ ...base, commandProducers: {} }),
    Error,
    "configuration.commandProducers must be an array",
  );
  assertThrows(
    () =>
      parseAgentsHostConfig({
        ...base,
        commandProducers: [{ id: "Workbench", piece: "fid1:piece" }],
      }),
    Error,
    'commandProducers[0].id must already be normalized as "workbench"',
  );
  assertThrows(
    () =>
      parseAgentsHostConfig({
        ...base,
        commandProducers: [{ id: "workbench", piece: "fid1:piece", extra: 1 }],
      }),
    Error,
    "commandProducers[0] has an unknown field: extra",
  );
  assertThrows(
    () =>
      parseAgentsHostConfig({
        ...base,
        commandProducers: [{ id: "workbench" }],
      }),
    Error,
    "commandProducers[0].piece must be a non-empty string",
  );
  assertThrows(
    () =>
      parseAgentsHostConfig({
        ...base,
        commandProducers: [
          { id: "workbench", piece: "fid1:one" },
          { id: "workbench", piece: "fid1:two" },
        ],
      }),
    Error,
    "configuration has duplicate command producer id: workbench",
  );
  assertThrows(
    () =>
      parseAgentsHostConfig({
        ...base,
        commandProducers: [
          { id: "workbench", piece: "fid1:one" },
          { id: "dashboard", piece: "fid1:one" },
        ],
      }),
    Error,
    "configuration has duplicate command producer piece: fid1:one",
  );
});
