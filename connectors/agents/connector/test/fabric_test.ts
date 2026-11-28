import { assert, assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  agentFabricCauses,
  AgentFabricTarget,
  recentSessionMessages,
  sessionIndexBuckets,
} from "../src/fabric.ts";
import {
  agentOwnerSchema,
  pushStableCellGraph,
  readStableCellGraphValue,
} from "../src/fabric-graph.ts";
import {
  sessionChunkCause,
  sessionManifestCause,
} from "../src/session-contract.ts";
import type { NativeSessionSnapshot, SourceDescriptor } from "../src/types.ts";
import { test } from "@commonfabric/test-support/test";

test("agent connector Fabric causes are stable", () => {
  assertEquals(agentFabricCauses("did:key:test", "did:key:owner"), {
    index: {
      spaceDid: "did:key:test",
      ownerDid: "did:key:owner",
      agentConnector: "recent-session-index",
    },
    allIndex: {
      spaceDid: "did:key:test",
      ownerDid: "did:key:owner",
      agentConnector: "all-session-index",
    },
    health: {
      spaceDid: "did:key:test",
      ownerDid: "did:key:owner",
      agentConnector: "health",
    },
    commands: {
      spaceDid: "did:key:test",
      ownerDid: "did:key:owner",
      agentConnector: "commands",
    },
    receipts: {
      spaceDid: "did:key:test",
      ownerDid: "did:key:owner",
      agentConnector: "receipts",
    },
  });
});

test("session indexes keep recent sessions and all sessions", () => {
  const generatedAt = "2026-07-10T12:00:00.000Z";
  const entries = [
    { id: "new", updatedAt: "2026-07-10T11:59:00.000Z" },
    { id: "boundary", updatedAt: "2026-07-03T12:00:00.000Z" },
    { id: "old", updatedAt: "2026-07-03T11:59:59.999Z" },
    { id: "unknown", updatedAt: null },
  ];

  const buckets = sessionIndexBuckets(entries, generatedAt);

  assertEquals(buckets.recent.map((entry) => entry.id), [
    "new",
    "boundary",
  ]);
  assertEquals(buckets.all.map((entry) => entry.id), [
    "new",
    "boundary",
    "old",
    "unknown",
  ]);
  assertEquals(buckets.olderCount, 2);
});

test("session index keeps only the newest normalized message previews", () => {
  const messages = Array.from({ length: 15 }, (_, index) => ({
    id: `message-${index}`,
    role: "assistant" as const,
    kind: "text",
    createdAt: null,
    textPreview: `Preview ${index}`,
    rawIndex: index,
  }));

  assertEquals(
    recentSessionMessages(messages).map((message) => message.id),
    messages.slice(-12).map((message) => message.id),
  );
  assertEquals(recentSessionMessages(messages, 2), messages.slice(-2));
  assertEquals(recentSessionMessages(messages, 0), []);
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  assert(isRecord(value), `expected a record: ${JSON.stringify(value)}`);
  return value;
}

function array(value: unknown): unknown[] {
  assert(Array.isArray(value), `expected an array: ${JSON.stringify(value)}`);
  return value;
}

/**
 * Publishes a one-chunk session, replaces its stored chunk's events with
 * tampered ones, rewrites its manifest with `tamperManifest`, publishes the
 * same session again, and returns the events the republished manifest's
 * chunk holds.
 */
async function republishedEventsAfterTampering(
  tamperManifest: (
    manifest: Record<string, unknown>,
  ) => Record<string, unknown>,
): Promise<unknown> {
  const signer = await Identity.fromPassphrase(
    "agent connector malformed manifest test",
  );
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const space = signer.did();
  const connection = { runtime, spaceDid: space, ownerDid: space };
  const source: SourceDescriptor = {
    id: "codex:test",
    driver: "codex-app-server",
    capabilities: {
      inventory: true,
      read: true,
      prompt: false,
      cancel: false,
      rename: false,
      setMode: false,
      setConfigOption: false,
    },
  };
  const snapshot: NativeSessionSnapshot = {
    summary: {
      nativeSessionId: "session-1",
      title: "Chunked",
      cwd: null,
      createdAt: "2026-07-17T10:00:00.000Z",
      updatedAt: "2026-07-17T10:01:00.000Z",
      archived: false,
      active: false,
      raw: { id: "session-1" },
    },
    events: [{ type: "message", text: "hello" }],
    normalizedMessages: [],
    complete: true,
  };
  const target = await AgentFabricTarget.open(connection);
  const publish = () =>
    target.publish([{
      source,
      sessions: [snapshot],
      errors: [],
      complete: true,
    }]);
  const manifestCell = async () => {
    const index = record(
      await readStableCellGraphValue(
        connection,
        target.cells.allIndex,
        new Map(),
        { preserveLinkFields: new Set(["manifest"]) },
      ),
    );
    const row = record(array(index.sessions)[0]);
    return runtime.getCell(
      space,
      sessionManifestCause(
        space,
        space,
        source.id,
        "session-1",
        source.driver,
        String(row.manifestHash),
      ),
      agentOwnerSchema(space),
    );
  };
  try {
    await publish();
    const manifest = await manifestCell();
    const published = record(
      await readStableCellGraphValue(connection, manifest, new Map(), {
        preserveLinkFields: new Set(["link"]),
      }),
    );
    const descriptor = record(array(published.chunks)[0]);
    const chunkCell = runtime.getCell(
      space,
      sessionChunkCause(
        space,
        space,
        source.id,
        "session-1",
        0,
        String(descriptor.contentHash),
      ),
      agentOwnerSchema(space),
    );
    const chunk = record(await readStableCellGraphValue(connection, chunkCell));
    await pushStableCellGraph(connection, [{
      cell: chunkCell,
      value: () => ({
        ...chunk,
        events: [{ type: "message", text: "tampered" }],
      }),
    }, {
      cell: manifest,
      value: () => tamperManifest(published),
    }]);

    await publish();

    const republished = record(
      await readStableCellGraphValue(connection, await manifestCell()),
    );
    return record(record(array(republished.chunks)[0]).link).events;
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
}

test("publication rewrites the chunks a malformed prior manifest lists", async () => {
  const original = [{ type: "message", text: "hello" }];
  const withDescriptor = (
    manifest: Record<string, unknown>,
    change: (descriptor: Record<string, unknown>) => unknown,
  ) => ({
    ...manifest,
    chunks: array(manifest.chunks).map((descriptor) =>
      change(record(descriptor))
    ),
  });
  const malformed: Array<
    (manifest: Record<string, unknown>) => Record<string, unknown>
  > = [
    (manifest) => ({ ...manifest, key: "codex%3Atest/another-session" }),
    (manifest) => ({ ...manifest, chunks: "not an array" }),
    (manifest) => withDescriptor(manifest, () => "not a record"),
    (manifest) =>
      withDescriptor(manifest, (descriptor) => ({ ...descriptor, part: 1 })),
    (manifest) =>
      withDescriptor(manifest, (descriptor) => ({
        ...descriptor,
        contentHash: 7,
      })),
  ];
  for (const tamper of malformed) {
    assertEquals(await republishedEventsAfterTampering(tamper), original);
  }

  // A well-formed prior manifest vouches for the chunk it lists, so the
  // stored chunk is reused as it is rather than written again.
  assertEquals(
    await republishedEventsAfterTampering((manifest) => ({
      ...manifest,
      snapshotHash: "a different snapshot",
    })),
    [{ type: "message", text: "tampered" }],
  );
});
