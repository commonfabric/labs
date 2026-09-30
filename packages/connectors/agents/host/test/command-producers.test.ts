import { AgentFabricTarget } from "@commonfabric/agents-connector/fabric";
import { createSession } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import { Runtime } from "@commonfabric/runner";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { fromFileUrl } from "@std/path";
import type { Cell } from "../../../../runner/src/builder/types.ts";
import { bindCommandProducers } from "../src/command-producers.ts";
import { defaultDebugPatternLocation } from "../src/debug-view.ts";
import {
  identity,
  materializeCell,
  renderedNodes,
  renderedText,
} from "./debug_view_support.ts";

const FIXTURE_ROOT = defaultDebugPatternLocation().rootPath;

function fixturePath(name: string): string {
  return fromFileUrl(new URL(`./fixtures/${name}`, import.meta.url));
}

/** Types `text` into a fixture piece's draft and presses its Send button. */
async function sendThrough(
  runtime: Runtime,
  piece: { result: { get(): unknown } },
  text: string,
): Promise<void> {
  await runtime.settled();
  const result = await piece.result.get() as Record<string, unknown>;
  const draft = renderedNodes(result["$UI"]).find((node) =>
    node.name === "cf-textarea"
  )?.props?.["$value"] as Cell<string>;
  const draftTx = runtime.edit();
  draft.withTx(draftTx).set(text);
  const draftCommit = await draftTx.commit();
  if (draftCommit.error) throw draftCommit.error;
  await runtime.settled();
  const sendButton = renderedNodes(result["$UI"]).find((node) =>
    node.name === "cf-button" && renderedText(node.children) === "Send"
  );
  const send = materializeCell(sendButton?.props?.onClick) as {
    send: (event: unknown) => void;
  };
  send.send({});
  await runtime.settled();
}

Deno.test("a configured producer piece sends commands through its own protected queue", async () => {
  const session = await createSession({
    identity,
    spaceName: `command-producer-${crypto.randomUUID()}`,
  });
  const storageManager = StorageManager.emulate({ as: session.as });
  let actingPrincipal = session.as.did();
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    trustSnapshotProvider: () => ({
      id: `principal:${actingPrincipal}`,
      actingPrincipal,
    }),
  });
  try {
    const manager = new PiecesController(session, runtime);
    await manager.synced();
    const target = await AgentFabricTarget.open({
      runtime,
      spaceDid: session.space,
      ownerDid: session.as.did(),
    });
    const program = await resolveLocalProgram(
      (resolver) => manager.runtime.harness.resolve(resolver),
      { main: fixturePath("command-producer.tsx"), root: FIXTURE_ROOT },
    );
    const piece = await manager.create(program, { input: {} });
    assertEquals(target.commandsAreBound(), false);

    const bound = await bindCommandProducers(manager, target, [
      { id: "fixture", piece: piece.id },
    ]);

    assertEquals(bound.map((producer) => producer.id), ["fixture"]);
    assertEquals(bound[0].piece, piece.id);
    assertEquals(typeof bound[0].commandCellId, "string");
    assertNotEquals(bound[0].commandCellId, target.commandCellId());
    assertEquals(target.commandsAreBound(), true);
    assertEquals(await target.pollCommands(), []);

    // The queue is now the piece's `commands` input, and its handler is the
    // queue's verified writer.
    await runtime.settled();
    const result = await piece.result.get() as Record<string, unknown>;
    const draft = renderedNodes(result["$UI"]).find((node) =>
      node.name === "cf-textarea"
    )?.props?.["$value"] as Cell<string>;
    const draftTx = runtime.edit();
    draft.withTx(draftTx).set(JSON.stringify({ type: "start", id: "one" }));
    const draftCommit = await draftTx.commit();
    if (draftCommit.error) throw draftCommit.error;
    await runtime.settled();
    const sendButton = renderedNodes(result["$UI"]).find((node) =>
      node.name === "cf-button" && renderedText(node.children) === "Send"
    );
    const send = materializeCell(sendButton?.props?.onClick) as {
      send: (event: unknown) => void;
    };
    assertEquals(typeof send.send, "function");

    actingPrincipal = "did:key:someone-else";
    send.send({});
    await runtime.settled();
    assertEquals(await target.pollCommands(), []);

    actingPrincipal = session.as.did();
    send.send({});
    await runtime.settled();
    assertEquals(await target.pollCommands(), [
      JSON.stringify({ type: "start", id: "one" }),
    ]);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("a producer whose pattern declares no command authorization is refused", async () => {
  const session = await createSession({
    identity,
    spaceName: `command-producer-unauthorized-${crypto.randomUUID()}`,
  });
  const storageManager = StorageManager.emulate({ as: session.as });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    const manager = new PiecesController(session, runtime);
    await manager.synced();
    const target = await AgentFabricTarget.open({
      runtime,
      spaceDid: session.space,
      ownerDid: session.as.did(),
    });
    const program = await resolveLocalProgram(
      (resolver) => manager.runtime.harness.resolve(resolver),
      {
        main: fixturePath("debug-view-without-command-authorization.tsx"),
        root: FIXTURE_ROOT,
      },
    );
    const piece = await manager.create(program, {
      input: { ownerDid: session.as.did() },
    });

    await assertRejects(
      () =>
        bindCommandProducers(manager, target, [
          { id: "silent", piece: piece.id },
        ]),
      Error,
      "command producer silent declares no verified command writer authorization",
    );
    assertEquals(target.commandsAreBound(), false);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("a producer whose command writer is defined in another module is refused", async () => {
  // The pattern transformer refuses a `WriteAuthorizedBy` over an imported
  // handler, so no compiled pattern declares one; the host still checks the
  // declaration it reads from a deployed piece against that piece's own
  // pattern identity, since the piece's schema need not have come through
  // that transformer. Fakes stand in for the manager and the target.
  const pattern = {
    resultSchema: {
      type: "object",
      properties: {
        commandAuthorization: {
          ifc: {
            writeAuthorizedBy: {
              __ctWriterIdentityOf: {
                file: "shared/handlers.tsx",
                moduleIdentity: "fid1:shared-handlers",
                path: ["sendCommand"],
              },
            },
          },
        },
      },
    },
  };
  const bindings: string[] = [];
  const manager = {
    get: () => Promise.resolve({ getPattern: () => Promise.resolve(pattern) }),
    runtime: {
      patternManager: {
        getArtifactEntryRef: () => ({
          identity: "fid1:producer-pattern",
          symbol: "default",
        }),
      },
    },
    link: () => Promise.resolve(),
  } as unknown as Parameters<typeof bindCommandProducers>[0];
  const target = {
    bindProducerCommandCell: (producerId: string) => {
      bindings.push(producerId);
      return Promise.reject(new Error("must not be reached"));
    },
  } as unknown as Parameters<typeof bindCommandProducers>[1];

  await assertRejects(
    () =>
      bindCommandProducers(manager, target, [
        { id: "borrower", piece: "fid1:piece" },
      ]),
    Error,
    "command producer borrower declares a command writer from module fid1:shared-handlers, not from its own pattern module fid1:producer-pattern",
  );
  assertEquals(bindings, []);
});

Deno.test("a producer whose pattern has no recorded identity is refused", async () => {
  // Without the pattern's identity the writer's module cannot be compared
  // with it, so the binding stops before any queue is created.
  const pattern = {
    resultSchema: {
      type: "object",
      properties: {
        commandAuthorization: {
          ifc: {
            writeAuthorizedBy: {
              __ctWriterIdentityOf: {
                file: "producer.tsx",
                moduleIdentity: "fid1:producer-pattern",
                path: ["sendCommand"],
              },
            },
          },
        },
      },
    },
  };
  const bindings: string[] = [];
  const manager = {
    get: () => Promise.resolve({ getPattern: () => Promise.resolve(pattern) }),
    runtime: { patternManager: { getArtifactEntryRef: () => undefined } },
    link: () => Promise.resolve(),
  } as unknown as Parameters<typeof bindCommandProducers>[0];
  const target = {
    bindProducerCommandCell: (producerId: string) => {
      bindings.push(producerId);
      return Promise.reject(new Error("must not be reached"));
    },
  } as unknown as Parameters<typeof bindCommandProducers>[1];

  await assertRejects(
    () =>
      bindCommandProducers(manager, target, [
        { id: "unrecorded", piece: "fid1:piece" },
      ]),
    Error,
    "command producer unrecorded's pattern has no recorded identity",
  );
  assertEquals(bindings, []);
});

Deno.test("a producer cannot write through another producer's queue", async () => {
  const session = await createSession({
    identity,
    spaceName: `command-producer-isolation-${crypto.randomUUID()}`,
  });
  const storageManager = StorageManager.emulate({ as: session.as });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    trustSnapshotProvider: () => ({
      id: `principal:${session.as.did()}`,
      actingPrincipal: session.as.did(),
    }),
  });
  try {
    const manager = new PiecesController(session, runtime);
    await manager.synced();
    const target = await AgentFabricTarget.open({
      runtime,
      spaceDid: session.space,
      ownerDid: session.as.did(),
    });
    const load = async (name: string) =>
      manager.create(
        await resolveLocalProgram(
          (resolver) => manager.runtime.harness.resolve(resolver),
          { main: fixturePath(name), root: FIXTURE_ROOT },
        ),
        { input: {} },
      );
    const first = await load("command-producer.tsx");
    const second = await load("command-producer-second.tsx");
    const bound = await bindCommandProducers(manager, target, [
      { id: "first", piece: first.id },
      { id: "second", piece: second.id },
    ]);
    assertNotEquals(bound[0].commandCellId, bound[1].commandCellId);

    // Each producer writes its own queue.
    await sendThrough(runtime, first, JSON.stringify({ id: "from-first" }));
    await sendThrough(runtime, second, JSON.stringify({ id: "from-second" }));
    assertEquals((await target.pollCommands()).toSorted(), [
      JSON.stringify({ id: "from-first" }),
      JSON.stringify({ id: "from-second" }),
    ]);

    // Pointed at the first producer's queue, the second producer's handler
    // is not that queue's writer, so its send is refused and nothing lands.
    await manager.link(bound[0].commandCellId, [], second.id, ["commands"], {
      start: false,
    });
    await sendThrough(runtime, second, JSON.stringify({ id: "intruder" }));
    assertEquals((await target.pollCommands()).toSorted(), [
      JSON.stringify({ id: "from-first" }),
      JSON.stringify({ id: "from-second" }),
    ]);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});
