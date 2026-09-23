#!/usr/bin/env -S deno run -A

import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { debugStr } from "@commonfabric/data-model";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { render } from "@commonfabric/html/client";
import { MockDoc } from "@commonfabric/html/mock-doc";
import {
  createSession,
  Identity,
  IdentityCreateConfig,
  Session,
} from "@commonfabric/identity";
import { env, waitFor } from "@commonfabric/integration";
import { Program } from "@commonfabric/js-compiler";
import {
  experimentalOptionsFromEnv,
  withServerExecutionDefault,
} from "@commonfabric/runner";
import {
  debugVDOMSchema,
  rendererVDOMSchema,
  vnodeSchema,
} from "@commonfabric/runner/schemas";
import {
  $conn,
  attachOptionsFrom,
  CellHandle,
  type JSONSchema,
  RequestType,
  type RuntimeAttachOptions,
  RuntimeClient,
  type RuntimeClientOptions,
  type VNode,
} from "@commonfabric/runtime-client";
import { MessagePortRuntimeTransport } from "@commonfabric/runtime-client/transports/message-port";
import { WebWorkerRuntimeTransport } from "@commonfabric/runtime-client/transports/web-worker";
import { defer } from "@commonfabric/utils/defer";

import { serverExecutionOnStepSkip } from "../../../tasks/server-execution-on-skips.ts";

const { API_URL } = env;

// Use a deserializable key implementation in Deno,
// as we cannot currently transfer WebCrypto implementation keys
// across serialized boundary
const keyConfig: IdentityCreateConfig = {
  implementation: "noble",
};

const identity = await Identity.fromPassphrase("test operator", keyConfig);

// Workers receive the host process's environment-selected flags. An absent
// server-execution declaration follows the first-party default.
const EXPERIMENTAL = withServerExecutionDefault(
  experimentalOptionsFromEnv(Deno.env.get),
);
const SERVER_EXECUTION_RESOLVED = EXPERIMENTAL.serverExecution;
const VIEW_SCOPED_REQUESTED = SERVER_EXECUTION_RESOLVED &&
  (EXPERIMENTAL.webViewScopedReplication ??
    EXPERIMENTAL.viewScopedReplication ?? false);

/**
 * The ON arm's STEP-level skip guard (tasks/server-execution-on-skips.ts):
 * a step listed there for this file is skipped ONLY when this process runs
 * the ON posture, loudly (the entry's reason is printed), and only while
 * the entry exists — the OFF arm and an unlisted step always run. Never a
 * silent filter: the CI step prints every entry, and the validator
 * requires this file to name each listed step and call this guard.
 */
function onArmStepSkip(step: string): { ignore: boolean } {
  if (SERVER_EXECUTION_RESOLVED !== true) return { ignore: false };
  const entry = serverExecutionOnStepSkip(
    "runtime-client",
    "integration/client.test.ts",
    step,
  );
  if (entry === undefined) return { ignore: false };
  console.warn(
    `[server-execution ON arm] runtime-client: ` +
      debugStr`SKIPPING STEP $quote,long${step}` +
      ` (until ${entry.phase}) — ${entry.reason}`,
  );
  return { ignore: true };
}

const TEST_PROGRAM = `import { Cell, NAME, pattern, UI } from "commonfabric";
export default pattern((_) => {
  const cell = new Cell("hello");
  return {
    [NAME]: "Home",
    [UI]: (
      <h1>
        home<strong>{cell}</strong>
      </h1>
    ),
  };
});`;

const TEMP_PATTERN = `import { Default, NAME, pattern, UI } from "commonfabric";

interface PatternState {
  count: Default<number, 0>;
  label: Default<string, "">;
}

export default pattern<PatternState>((state) => {
  return {
    [NAME]: state.label,
    [UI]: (
      <section>
        {state && state.count > 0 ? <p>Positive</p> : <p>Non-positive</p>}
      </section>
    ),
  };
});
`;

const FOLLOWED_SOURCE_V1 = `import { pattern } from "commonfabric";

interface PatternState {
  seed?: string;
}

export default pattern<PatternState>(() => ({ version: "current" }));
`;

const FOLLOWED_SOURCE_V2 = `import { pattern } from "commonfabric";

interface PatternState {
  seed?: number;
}

export default pattern<PatternState>(() => ({ version: "candidate" }));
`;

describe("RuntimeClient", () => {
  describe("lifecycle", () => {
    it("initializes and reaches ready state", async () => {
      const session = await createTestSession();
      const rt = await createRuntimeClient(session);
      await rt.dispose();
    });
  });

  describe("named spaces", () => {
    it("resolves and opens a runtime-derived named space", async () => {
      const session = await createTestSession();
      await using rt = await createRuntimeClient(session);
      const name = `runtime-client-named-${crypto.randomUUID()}`;
      const expected = await createSession({
        identity: session.as,
        spaceName: name,
      });

      const space = await rt.resolveSpaceName(name);
      assertEquals(space, expected.space);
      const root = await rt.getSpaceRootPattern(space);
      assertExists(root);
      await rt.synced(space);
    });
  });

  describe("cell operations", () => {
    it("creates a cell with getCell and syncs its value", async () => {
      const session = await createTestSession();
      await using rt = await createRuntimeClient(session);

      const schema = {
        type: "object",
        properties: {
          message: { type: "string" },
          count: { type: "number" },
        },
      } as const satisfies JSONSchema;

      const cause = "test-cell-" + Date.now();
      const cell = await rt.getCell<{ message: string; count: number }>(
        session.space,
        cause,
        schema,
      );

      const input = { message: "hi", count: 0 };
      await cell.set(input);
      await cell.sync();
      const value = await new Promise((resolve) => {
        cell.subscribe((value) => {
          resolve(value);
        });
      });
      assertEquals(value, input);
    });

    it("carries a fabric value through a real worker, set to sync to subscribe", async () => {
      // The envelope's whole purpose, at the seam it exists for: a real
      // `RuntimeClient` over a real Worker, with no encoding double standing
      // in for the crossing. Structured cloning would have stripped the
      // `FabricBytes` to `{}` on the way, and a `bigint` it refuses outright,
      // so each arm below fails differently without the envelope rather than
      // all of them failing the same way.
      const session = await createTestSession();
      await using rt = await createRuntimeClient(session);

      const schema = { type: "object" } as const satisfies JSONSchema;
      const cause = "test-fabric-value-" + Date.now();
      const cell = await rt.getCell<Record<string, unknown>>(
        session.space,
        cause,
        schema,
      );

      const content = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
      await cell.set({
        bytes: new FabricBytes(content),
        big: 9007199254740993n,
        tag: Symbol.for("cf.test.interned"),
      });
      await rt.idle();

      const synced = await cell.sync() as Record<string, unknown>;
      assert(
        synced.bytes instanceof FabricBytes,
        `synced back ${
          (synced.bytes as { constructor?: { name?: string } })?.constructor
            ?.name ?? String(synced.bytes)
        }, not a FabricBytes`,
      );
      assertEquals(synced.bytes.slice(), content);
      // A `bigint` past `Number.MAX_SAFE_INTEGER`, so a number round trip
      // would not return it even if one carried the arm at all.
      assertEquals(synced.big, 9007199254740993n);
      // Interned, which is the only symbol the fabric boundary admits: a
      // unique one has no identity to rebuild on the far side.
      assertEquals(synced.tag, Symbol.for("cf.test.interned"));

      // The notification path is a separate crossing from the response path,
      // and it is watched from a SECOND handle on the same cell. The writing
      // handle is no good for it: `set()` updates its own cache and calls its
      // own subscribers synchronously with the object it was handed, so a
      // subscriber there would be shown the value it just built and would say
      // `instanceof FabricBytes` about a `FabricBytes` that never left the
      // process. `getCell()` returns a fresh handle, and this one never
      // writes, so every value it is given arrived over the connection.
      const nextContent = new Uint8Array([1, 2, 3]);
      const reader = await rt.getCell<Record<string, unknown>>(
        session.space,
        cause,
        schema,
      );
      const gotNext = defer<Record<string, unknown>>();
      const cancel = reader.subscribe((value) => {
        const record = value as Record<string, unknown> | undefined;
        if (record?.marker === "second") gotNext.resolve(record);
      });

      const sent = {
        bytes: new FabricBytes(nextContent),
        marker: "second",
      };
      await cell.set(sent);

      const delivered = await gotNext.promise;
      cancel();
      // Not the object that was written, which is what says this came back
      // rather than across.
      assert(delivered !== sent);
      assert(
        delivered.bytes instanceof FabricBytes,
        `delivered ${
          (delivered.bytes as { constructor?: { name?: string } })?.constructor
            ?.name ?? String(delivered.bytes)
        }, not a FabricBytes`,
      );
      assertEquals(delivered.bytes.slice(), nextContent);
    });

    it("recursively returns VNodes inline with schema-driven serialization", async () => {
      const session = await createTestSession();
      await using rt = await createRuntimeClient(session);

      const piece = await rt.createPiece<{ $UI: VNode }>(
        TEMP_PATTERN,
        session.space,
        {
          run: true,
        },
      );
      // The default piece handle may expose only the opaque UI tip. This
      // reader requests the VNode structure it serializes explicitly.
      const cell = piece.cell();
      const uiCell = VIEW_SCOPED_REQUESTED
        ? cell.key("$UI").asSchema<VNode>(debugVDOMSchema)
        : cell.key("$UI");
      // A sync reads the current value while the server may still be forming
      // the conditional child. Observe that child's arrival before checking
      // the serialization returned by the one-shot read.
      const childArrived = defer<void>();
      const cancel = uiCell.subscribe((value) => {
        if (Array.isArray(value?.children) && value.children[0] != null) {
          childArrived.resolve();
        }
      });
      try {
        await childArrived.promise;
        const value = VIEW_SCOPED_REQUESTED
          ? await uiCell.sync()
          : (await cell.sync())?.$UI;
        const children = value?.children as VNode[];
        const firstChild = children?.[0];
        assertEquals(firstChild?.children, ["Non-positive"]);
        assertEquals(firstChild?.name, "p");
      } finally {
        cancel();
      }
    });

    it("resolves cell links with resolveAsCell()", async () => {
      const session = await createTestSession();
      await using rt = await createRuntimeClient(session);

      // Create a target cell with some data
      const targetSchema = {
        type: "object",
        properties: { value: { type: "string" } },
      } as const satisfies JSONSchema;

      const targetCell = await rt.getCell<{ value: string }>(
        session.space,
        "resolve-target-" + Date.now(),
        targetSchema,
      );
      await targetCell.set({ value: "resolved!" });
      await rt.idle();

      // Create a source cell that contains a link to the target
      const sourceSchema = {
        type: "object",
        properties: { link: { type: "object" } },
      } as const satisfies JSONSchema;

      const sourceCell = await rt.getCell<{ link: unknown }>(
        session.space,
        "resolve-source-" + Date.now(),
        sourceSchema,
      );
      await sourceCell.set({ link: targetCell });
      await rt.idle();
      await sourceCell.sync();

      // Get the link cell and resolve it
      const linkCell = sourceCell.key("link");
      const resolved = await linkCell.resolveAsCell();

      // The resolved cell should point to the target
      assertEquals(resolved.id(), targetCell.id());
    });

    it("subscribes to cell updates via subscribe()", async () => {
      const session = await createTestSession();
      await using rt = await createRuntimeClient(session);

      const schema = {
        type: "object",
        properties: { counter: { type: "number" } },
      } as const satisfies JSONSchema;

      const cell = await rt.getCell<{ counter: number }>(
        session.space,
        "test-sink-" + Date.now(),
        schema,
      );

      cell.set({ counter: 0 });
      await rt.idle();
      await cell.sync();

      const receivedValues: { counter: number }[] = [];
      const gotThree = defer<void>();
      const cancel = cell.subscribe((value) => {
        if (!value) throw new Error("cell was not synced");
        receivedValues.push(value);
        if (receivedValues.length >= 3) gotThree.resolve();
      });

      cell.set({ counter: 1 });
      cell.set({ counter: 2 });
      cell.set({ counter: 3 });

      await gotThree.promise;

      cancel();

      // Should have received updates (may include initial value)
      assertEquals(receivedValues.length >= 3, true);
      assertEquals(receivedValues[receivedValues.length - 1], { counter: 3 });
    });

    it("updates multiple instances of the same cell with different schema", async () => {
      const session = await createTestSession();
      await using rt = await createRuntimeClient(session);

      const schema = {
        type: "string",
      } as const satisfies JSONSchema;

      const cause = "test-cell-" + Date.now();
      const cell = await rt.getCell<string>(
        session.space,
        cause,
        schema,
      );

      const cell2 = cell.asSchema<string>({
        type: "string",
        default: "default-string",
      });

      let _updatedValue1 = undefined;
      const cancel1 = cell.subscribe((value) => {
        _updatedValue1 = value;
      });
      let _updatedValue2 = undefined;
      const gotValue = defer<void>();
      const cancel2 = cell2.subscribe((value) => {
        _updatedValue2 = value;
        if (cell2.get() === "my-value") gotValue.resolve();
      });

      await cell.set("my-value");
      await gotValue.promise;
      cancel1();
      cancel2();
    });

    it("dispatches CellHandle.push as a CellPush (read-modify-write append)", async () => {
      const session = await createTestSession();
      await using rt = await createRuntimeClient(session);

      const schema = {
        type: "array",
        items: { type: "string" },
      } as const satisfies JSONSchema;

      const cell = await rt.getCell<string[]>(
        session.space,
        "test-push-" + Date.now(),
        schema,
      );
      await cell.set(["a"]);
      await rt.idle();
      await cell.sync();

      // push routes through CellPush -> handleCellPush (read-modify-write),
      // appending to the current array rather than blindly overwriting it.
      cell.push("b");
      await rt.idle();
      await cell.sync();

      assertEquals(cell.get(), ["a", "b"]);
    });

    it("late subscribers receive initial value from existing subscription", async () => {
      // A late subscriber is one that joins a subscription another handle
      // opened, so no backend request is made for it.
      // `RuntimeConnection.subscribe()` copies the cached value from an
      // existing subscriber to the one joining.

      const session = await createTestSession();
      await using rt = await createRuntimeClient(session);

      const schema = {
        type: "object",
        properties: { message: { type: "string" } },
      } as const satisfies JSONSchema;

      // Create a cell and set an initial value
      const cell = await rt.getCell<{ message: string }>(
        session.space,
        "test-late-subscriber-" + Date.now(),
        schema,
      );
      await cell.set({ message: "hello world" });
      await rt.idle();
      await cell.sync();

      // Create two CellHandles with the SAME schema - this produces the same
      // subscription key, which the schema is part of.
      const cellA = cell.asSchema<{ message: string }>(schema);
      const cellB = cell.asSchema<{ message: string }>(schema);

      // Subscribe cellA first - this establishes the backend subscription
      const valuesA: ({ message: string } | undefined)[] = [];
      const valuesB: ({ message: string } | undefined)[] = [];
      const gotInitialA = defer<void>();
      const bothUpdated = defer<void>();
      const checkBothUpdated = () => {
        if (
          valuesA.some((v) => v?.message === "updated") &&
          valuesB.some((v) => v?.message === "updated")
        ) {
          bothUpdated.resolve();
        }
      };
      const cancelA = cellA.subscribe((v) => {
        valuesA.push(v);
        if (valuesA.length > 0 && valuesA[valuesA.length - 1] !== undefined) {
          gotInitialA.resolve();
        }
        checkBothUpdated();
      });

      // Wait for initial value to arrive from backend
      await gotInitialA.promise;

      // Verify cellA received the value
      assertEquals(
        valuesA[valuesA.length - 1],
        { message: "hello world" },
        "First subscriber should receive value",
      );

      // Now subscribe cellB - this is the "late subscriber" that joins an
      // existing subscription, so no new backend request is made.
      const cancelB = cellB.subscribe((v) => {
        valuesB.push(v);
        checkBothUpdated();
      });

      // cellB receives the cached value synchronously, in the subscribe() call
      assertEquals(
        valuesB.length,
        1,
        "Late subscriber should receive immediate callback",
      );
      assertEquals(
        valuesB[0],
        { message: "hello world" },
        "Late subscriber should receive cached value, not undefined",
      );

      // Also verify both receive subsequent updates
      await cell.set({ message: "updated" });
      checkBothUpdated();
      await bothUpdated.promise;

      cancelA();
      cancelB();
    });
  });

  describe("piece operations", () => {
    it("creates a piece from URL and retrieves it", async () => {
      const session = await createTestSession();
      await using rt = await createRuntimeClient(session);

      const piece = await rt.createPiece(TEST_PROGRAM, session.space, {
        run: true,
      });
      assertExists(piece.id());
    });

    it("reads a created piece's source state", async () => {
      const session = await createTestSession();
      await using rt = await createRuntimeClient(session);

      const piece = await rt.createPiece(TEST_PROGRAM, session.space, {
        run: true,
      });
      const source = await rt.getPieceSource(piece.id(), session.space);

      assertEquals(source.space, session.space);
      assertExists(source.pattern);
      // A piece created from a program records no origin: nothing supplies new
      // code for it. Its first exact source remains available as detached
      // history.
      assertEquals(source.origin, undefined);
      // Its authored source is retained in its own space, entry file first.
      assertExists(source.entry);
      assertEquals(source.files[0].name, source.entry);
      assertEquals(
        source.history.map((revision) => revision.operation),
        ["create"],
      );
      assertEquals(
        source.files.some((file) => file.contents.includes("home")),
        true,
      );
      const revisionSource = await rt.getPieceSourceRevision(
        piece.id(),
        session.space,
        source.history[0].revisionId,
      );
      assertEquals(revisionSource.pattern, source.history[0].pattern);
      assertEquals(revisionSource.files, source.files);
    });

    it("clones a piece into another named space and follows it", async () => {
      const session = await createTestSession();
      await using rt = await createRuntimeClient(session);
      const sourcePiece = await rt.createPiece(TEST_PROGRAM, session.space, {
        run: true,
      });
      const destinationName = `piece-clone-${crypto.randomUUID()}`;
      const destinationSpace = await rt.resolveSpaceName(destinationName);

      const clone = await rt.clonePiece(
        sourcePiece.id(),
        session.space,
        destinationSpace,
      );
      const source = await rt.getPieceSource(sourcePiece.id(), session.space);
      const cloned = await rt.getPieceSource(clone.id(), destinationSpace);

      assertEquals(cloned.space, destinationSpace);
      assertEquals(cloned.pattern, source.pattern);
      assertEquals(cloned.origin, {
        url: `cf:/${session.space}/${sourcePiece.cell().id()}`,
        kind: "fabric-piece",
      });
      assertEquals(
        cloned.history.map((revision) => revision.operation),
        ["create"],
      );
    });

    it("clones a piece's input data through the runtime protocol", async () => {
      const session = await createTestSession();
      await using rt = await createRuntimeClient(session);
      const sourcePiece = await rt.createPiece(TEMP_PATTERN, session.space, {
        argument: { count: 7, label: "copied label" },
        run: true,
      });
      const destinationName = `piece-clone-data-${crypto.randomUUID()}`;
      const destinationSpace = await rt.resolveSpaceName(destinationName);

      const clone = await rt.clonePiece(
        sourcePiece.id(),
        session.space,
        destinationSpace,
        { copyData: true },
      );
      const response = await rt[$conn]().request<RequestType.CellGet>({
        type: RequestType.CellGet,
        cell: clone.cell().ref(),
        meta: "argument",
        includeRef: true,
      });

      assertEquals(response.value, { count: 7, label: "copied label" });
    });

    it("detaches a followed root through the runtime-client protocol", async () => {
      const session = await createTestSession();
      await using rt = await createRuntimeClient(session);
      const root = await rt.getSpaceRootPattern(session.space);
      const before = await rt.getPieceSource(root.id(), session.space);
      assertExists(before.origin);

      const response = await rt.updatePieceSource(
        root.id(),
        session.space,
        { kind: "detach" },
      );

      assertEquals(response.compatibilityWarning, undefined);
      assertEquals(response.source.origin, undefined);
      assertEquals(
        response.source.pattern?.identity,
        before.pattern?.identity,
      );
      assertEquals(
        response.source.history.map((revision) => revision.operation),
        ["baseline", "detach"],
      );
    });

    it("confirms an incompatible followed source with a one-use token", async () => {
      const session = await createTestSession();
      await using rt = await createRuntimeClient(session);
      await assertRejects(
        () =>
          rt.createPiece(
            new URL("data:text/typescript,export%20default%2042"),
            session.space,
          ),
        Error,
        "Piece source URL must use HTTP or HTTPS",
      );

      // A URL is a place to read a program from once, not an origin: the piece
      // it creates records none, and its owner names one afterwards.
      const sourceServer = Deno.serve(
        { hostname: "127.0.0.1", port: 0, onListen: () => {} },
        () =>
          new Response(FOLLOWED_SOURCE_V1, {
            headers: { "content-type": "text/typescript-jsx" },
          }),
      );
      const address = sourceServer.addr as Deno.NetAddr;
      try {
        const fetched = await rt.createPiece(
          new URL(`http://${address.hostname}:${address.port}/fetched.tsx`),
          session.space,
          { argument: {}, run: true },
        );
        const fetchedSource = await rt.getPieceSource(
          fetched.id(),
          session.space,
        );
        assertEquals(fetchedSource.origin, undefined);
        assertEquals(fetchedSource.unusableOrigin, undefined);
      } finally {
        await sourceServer.shutdown();
      }

      // The upstream piece runs source whose argument contract differs from
      // the follower's, so following it is a contract change its owner has to
      // confirm. That confirmation is what this test drives over the wire.
      const upstream = await rt.createPiece(FOLLOWED_SOURCE_V2, session.space, {
        argument: {},
        run: true,
      });
      const piece = await rt.createPiece(FOLLOWED_SOURCE_V1, session.space, {
        argument: {},
        run: true,
      });
      const url = `cf:/${session.space}/${upstream.id()}`;
      const action = { kind: "repoint" as const, url };

      const warning = await rt.updatePieceSource(
        piece.id(),
        session.space,
        action,
      );
      assertExists(warning.compatibilityWarning);
      assertExists(warning.confirmationToken);
      assertEquals(warning.source.origin, undefined);

      await assertRejects(
        () =>
          rt.updatePieceSource(piece.id(), session.space, action, {
            confirmationToken: "",
          }),
        Error,
        "confirmationToken must be a non-empty string",
      );
      await assertRejects(
        () =>
          rt.updatePieceSource(piece.id(), session.space, action, {
            confirmationToken: 42,
          } as unknown as { confirmationToken: string }),
        Error,
        "confirmationToken must be a non-empty string",
      );

      const applied = await rt.updatePieceSource(
        piece.id(),
        session.space,
        action,
        { confirmationToken: warning.confirmationToken },
      );
      assertEquals(applied.compatibilityWarning, undefined);
      assertEquals(applied.confirmationToken, undefined);
      assertEquals(applied.source.origin?.url, url);

      await assertRejects(
        () =>
          rt.updatePieceSource(piece.id(), session.space, action, {
            confirmationToken: warning.confirmationToken,
          }),
        Error,
        "compatibility confirmation is no longer valid",
      );
    });

    it("retrieves a piece with its result schema, including UI", async () => {
      const session = await createTestSession();
      await using rt = await createRuntimeClient(session);

      const piece = await rt.createPiece(TEST_PROGRAM, session.space, {
        run: true,
      });
      const retrieved = await rt.getPiece(piece.id(), session.space, true);
      assertExists(retrieved);

      const cell = VIEW_SCOPED_REQUESTED
        ? retrieved.cell().asSchema({
          type: "object",
          properties: {
            $NAME: { type: "string" },
            $UI: vnodeSchema,
          },
        })
        : retrieved.cell();
      await cell.sync();
      const value = cell.get() as { $UI?: VNode; $NAME?: string };

      assertEquals(value.$NAME, "Home");
      assertExists(value.$UI, "Retrieved piece cell should include $UI");
      assertEquals(value.$UI.name, "h1");
    });

    it("starts and stops piece execution", async () => {
      const session = await createTestSession();
      await using rt = await createRuntimeClient(session);

      const piece = await rt.createPiece(TEST_PROGRAM, session.space, {
        run: false,
      });
      await piece.start();
      await rt.idle();
      await piece.stop();
    });

    it("removes a piece", async () => {
      const session = await createTestSession();
      await using rt = await createRuntimeClient(session);

      const piece = await rt.createPiece(TEST_PROGRAM, session.space, {
        run: false,
      });
      await rt.removePiece(piece.id(), session.space);
      await rt.synced(session.space);

      // Note: getPiece may still return a reference to a removed piece
      // because the ID still maps to a cell that existed. The removal
      // affects the pieces list, not the ability to lookup by ID.
    });

    it("gets the pieces list cell", async () => {
      const session = await createTestSession();
      await using rt = await createRuntimeClient(session);

      const piecesListCell = await rt.getPiecesListCell(session.space);
      assertExists(piecesListCell);

      await piecesListCell.sync();
      const link = piecesListCell.ref();
      assertExists(link);
    });
  });

  describe("events", () => {
    it("emits console events from piece execution", async () => {
      const consolePattern = `import { NAME, pattern, UI } from "commonfabric";
export default pattern((_) => {
  console.log('hello');
  return {
    [NAME]: "Home",
    [UI]: (<span>console</span>),
  };
});`;

      const consoleProgram: Program = {
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: consolePattern,
        }],
      };
      const session = await createTestSession();
      await using rt = await createRuntimeClient(session);

      const consoleEvents: { method: string; args: readonly unknown[] }[] = [];
      const gotHello = defer<void>();
      rt.on(
        "console",
        (
          event,
        ) => {
          consoleEvents.push(event);
          if (
            consoleEvents.length > 0 && consoleEvents[0].args[0] === "hello"
          ) {
            gotHello.resolve();
          }
        },
      );

      await rt.createPiece(consoleProgram, session.space, { run: true });
      await rt.idle();

      await gotHello.promise;
    });
  });

  describe("event handlers", () => {
    it("sends events to stream cells without schema error", async () => {
      const session = await createTestSession();
      await using rt = await createRuntimeClient(session);

      // Create a cell with undefined schema (simulating what happens with handler streams)
      const cell = await rt.getCell(
        session.space,
        "test-stream-send-" + Date.now(),
        undefined, // No schema - this is what causes the proxy fallback
      );

      cell.send({ type: "click", target: "button" });

      await rt.idle();
      await cell.sync();

      // Verify the event was stored
      const value = cell.get() as { type?: string };
      assertEquals(value?.type, "click", "Event should be stored in cell");
    });

    it("sends events to nested stream cell paths without schema error", async () => {
      const session = await createTestSession();
      await using rt = await createRuntimeClient(session);

      // Create a root cell with nested runtime metadata-shaped content.
      const rootCell = await rt.getCell(
        session.space,
        "test-nested-stream-" + Date.now(),
        undefined,
      );

      // First, set up the internal structure
      rootCell.set({ internal: {} });
      await rt.idle();
      await rootCell.sync();

      // Now get a nested cell reference to internal/__#0stream (mimicking handler stream path)
      const internalCell = (rootCell as any).key("internal");
      const streamCell = (internalCell as any).key("__#0stream");
      streamCell.send({ type: "click" });

      await rt.idle();
      await rootCell.sync();
    });
  });

  describe("html render", () => {
    it("retrieves UI markup from piece cell", async () => {
      const session = await createTestSession();
      await using rt = await createRuntimeClient(session);

      const piece = await rt.createPiece(TEST_PROGRAM, session.space, {
        run: true,
      });
      const cell = piece.cell();
      await cell.sync();
      const value = cell.get() as { $UI?: VNode; $NAME?: string };

      // Verify we can access the UI markup
      assertExists(value.$UI, "Cell should have $UI property");
      assertEquals(value.$UI.type, "vnode");
      assertEquals(value.$UI.name, "h1");
    });

    it("renders piece UI using html render function with CellHandle", async () => {
      const session = await createTestSession();
      await using rt = await createRuntimeClient(session);

      const piece = await rt.createPiece(TEST_PROGRAM, session.space, {
        run: true,
      });
      const cell = piece.cell();
      await cell.sync();
      const typedCell = cell as typeof cell & { key(k: "$UI"): typeof cell };
      const uiCell = typedCell.key("$UI").asSchema(rendererVDOMSchema);
      await uiCell.sync();

      const mock = new MockDoc(
        `<!DOCTYPE html><html><body><div id="root"></div></body></html>`,
      );
      const { document, renderOptions } = mock;
      const root = document.getElementById("root")!;

      const cancel = render(root, uiCell as any, renderOptions);

      const expected = "<h1>home<strong>hello</strong></h1>";
      await waitFor(() => Promise.resolve(root.innerHTML === expected));
      assertEquals(
        root.innerHTML,
        expected,
        "Should render the piece UI correctly",
      );

      cancel();
    });

    it("renders a nested pattern component placed in a parent's tree", async () => {
      const nestedPattern =
        `import { NAME, pattern, UI, type VNode } from "commonfabric";

interface ChildOutput {
  [NAME]: string;
  [UI]: VNode;
}

interface ParentOutput {
  [NAME]: string;
  [UI]: VNode;
}

const Child = pattern<unknown, ChildOutput>(() => {
  return {
    [NAME]: "Nested child",
    [UI]: <span id="nested-child">Nested child rendered</span>,
  };
});

export default pattern<unknown, ParentOutput>(() => {
  const child = Child({});
  return {
    [NAME]: "Unknown UI parent",
    [UI]: (
      <div id="unknown-ui-parent">
        {child}
        <p id="sibling-after-child">Sibling rendered</p>
      </div>
    ),
  };
});`;

      const nestedProgram: Program = {
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: nestedPattern,
        }],
      };

      const session = await createTestSession();
      await using rt = await createRuntimeClient(session);

      const piece = await rt.createPiece(nestedProgram, session.space, {
        run: true,
      });
      const mock = new MockDoc(
        `<!DOCTYPE html><html><body><div id="root"></div></body></html>`,
      );
      const { document, renderOptions } = mock;
      const root = document.getElementById("root")!;

      const cancel = render(root, piece.cell() as any, renderOptions);

      await waitFor(
        () =>
          Promise.resolve(
            root.innerHTML.includes("Nested child rendered") &&
              root.innerHTML.includes("Sibling rendered"),
          ),
        { timeout: 5000 },
      );
      assertEquals(
        root.innerHTML.includes('id="nested-child"'),
        true,
        "Should render the nested child pattern UI",
      );

      cancel();
    });

    it("renders cell values in VNode children", async () => {
      // Pattern that renders a state value in the UI
      const valuePattern =
        `import { Default, NAME, pattern, UI } from "commonfabric";

interface State {
  value: Default<number, 10>;
}

export default pattern<State>(({ value }) => {
  return {
    [NAME]: "Value Test",
    [UI]: (
      <div>
        <span id="value">Value is {value}</span>
      </div>
    ),
  };
});`;

      const valueProgram: Program = {
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: valuePattern,
        }],
      };

      const session = await createTestSession();
      await using rt = await createRuntimeClient(session);

      const piece = await rt.createPiece(valueProgram, session.space, {
        run: true,
      });
      const mock = new MockDoc(
        `<!DOCTYPE html><html><body><div id="root"></div></body></html>`,
      );
      const { document, renderOptions } = mock;
      const root = document.getElementById("root")!;

      const cancel = render(root, piece.cell() as any, renderOptions);

      await waitFor(
        () => Promise.resolve(root.innerHTML.includes("Value is 10")),
        { timeout: 5000 },
      );

      cancel();
    });

    it("renders derived cell values (like nth function)", async () => {
      // Pattern that uses a derived expression similar to counter's nth(state.value)
      const derivedPattern =
        `import { Default, NAME, pattern, UI } from "commonfabric";

function formatValue(n: number): string {
  return "number-" + n;
}

interface State {
  value: Default<number, 42>;
}

export default pattern<State>(({ value }) => {
  return {
    [NAME]: "Derived Test",
    [UI]: (
      <div>
        <span id="result">Result: {formatValue(value)}</span>
      </div>
    ),
  };
});`;

      const derivedProgram: Program = {
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: derivedPattern,
        }],
      };

      const session = await createTestSession();
      await using rt = await createRuntimeClient(session);

      const piece = await rt.createPiece(derivedProgram, session.space, {
        run: true,
      });
      const cell = piece.cell() as CellHandle<VNode>;
      const mock = new MockDoc(
        `<!DOCTYPE html><html><body><div id="root"></div></body></html>`,
      );
      const { document, renderOptions } = mock;
      const root = document.getElementById("root")!;

      const cancel = render(root, cell, renderOptions);

      await waitFor(
        () => Promise.resolve(root.innerHTML.includes("Result: number-42")),
        { timeout: 15000 },
      );
      cancel();
    });

    it({
      name:
        "renders PerUser-derived computed JSX inside cf-screen header slot (CT-1606)",
      ...onArmStepSkip(
        "renders PerUser-derived computed JSX inside cf-screen header slot (CT-1606)",
      ),
      fn: async () => {
        const scopedHeaderPattern = `import {
  computed,
  Default,
  NAME,
  pattern,
  type PerSpace,
  type PerUser,
  UI,
  type VNode,
} from "commonfabric";

const trimmedName = (name: string | undefined) => (name ?? "").trim();

interface Input {
  question?: PerSpace<string | Default<"Where should we eat?">>;
  myName?: PerUser<string | Default<"">>;
}

interface Output {
  [NAME]: string;
  [UI]: VNode;
  myName: PerUser<string | Default<"">>;
}

export default pattern<Input, Output>(({ question, myName }) => {
  return {
    [NAME]: "ct-1606-scoped-header-slot",
    myName,
    [UI]: (
      <cf-screen>
        <div slot="header">
          <h2>{question}</h2>
          {computed(() => {
            const value = trimmedName(myName);
            return <div>me is: "{value}"</div>;
          })}
        </div>
        <div>body renders</div>
      </cf-screen>
    ),
  };
});`;

        const scopedHeaderProgram: Program = {
          main: "/main.tsx",
          files: [{
            name: "/main.tsx",
            contents: scopedHeaderPattern,
          }],
        };

        const session = await createTestSession();
        await using rt = await createRuntimeClient(session);

        const piece = await rt.createPiece(scopedHeaderProgram, session.space, {
          run: true,
        });
        const cell = piece.cell() as CellHandle<VNode>;
        const nameCell = (piece.cell() as any).key("myName").asSchema({
          type: "string",
          scope: "user",
        });
        const mock = new MockDoc(
          `<!DOCTYPE html><html><body><div id="root"></div></body></html>`,
        );
        const { document, renderOptions } = mock;
        const root = document.getElementById("root")!;

        const cancel = render(root, cell, renderOptions);

        try {
          await waitFor(
            () => {
              const html = root.innerHTML;
              return Promise.resolve(
                html.includes("Where should we eat?") &&
                  html.includes("me is: &quot;&quot;") &&
                  html.includes("body renders"),
              );
            },
            { timeout: 15000 },
          );

          await nameCell.set("Alex");
          await waitFor(
            () =>
              Promise.resolve(
                root.innerHTML.includes("me is: &quot;Alex&quot;"),
              ),
            { timeout: 5000 },
          );
        } finally {
          cancel();
        }
      },
    });

    it("dispatches click events through rendered piece handlers", async () => {
      const clickPattern =
        `import { action, Default, NAME, pattern, UI, Writable } from "commonfabric";

interface State {
  value: Writable<Default<number, 0>>;
}

export default pattern<State>(({ value }) => {
  const increment = action(() => {
    value.set(value.get() + 1);
  });

  return {
    [NAME]: "Click Test",
    value,
    [UI]: (
      <div>
        <button id="increment" onClick={increment}>Increment</button>
        <span id="value">{value}</span>
      </div>
    ),
  };
});`;

      const clickProgram: Program = {
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: clickPattern,
        }],
      };

      const session = await createTestSession();
      await using rt = await createRuntimeClient(session);

      const piece = await rt.createPiece(clickProgram, session.space, {
        run: true,
      });
      const valueCell = (piece.cell() as any).key("value").asSchema({
        type: "number",
      });
      const mock = new MockDoc(
        `<!DOCTYPE html><html><body><div id="root"></div></body></html>`,
      );
      const { document, renderOptions } = mock;
      const root = document.getElementById("root")!;

      const cancel = render(root, piece.cell() as any, renderOptions);

      await waitFor(
        () => Promise.resolve(root.innerHTML.length > 0),
        { timeout: 5000 },
      );
      assertEquals(await valueCell.sync(), 0);

      const button = root.getElementsByTagName("button")[0] as any;
      assertExists(button);

      button.dispatchEvent({ type: "click", target: button });

      await waitFor(
        async () => await valueCell.sync() === 1,
        { timeout: 5000 },
      );

      await waitFor(
        () => Promise.resolve(root.innerHTML.includes(">1</span>")),
        { timeout: 5000 },
      );

      cancel();
    });

    it("commits click events through rendered handler streams", async () => {
      const clickPattern =
        `import { Default, handler, NAME, pattern, UI, Writable } from "commonfabric";

interface State {
  value: Writable<Default<number, 0>>;
}

const increment = handler<void, { value: Writable<number> }>((_, { value }) => {
  value.set(value.get() + 1);
});

export default pattern<State>(({ value }) => {
  return {
    [NAME]: "Handler Click Test",
    value,
    [UI]: (
      <div>
        <button id="increment" onClick={increment({ value })}>Increment</button>
        <span id="value">{value}</span>
      </div>
    ),
  };
});`;

      const clickProgram: Program = {
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: clickPattern,
        }],
      };

      const session = await createTestSession();
      await using rt = await createRuntimeClient(session);

      const piece = await rt.createPiece(clickProgram, session.space, {
        run: true,
      });
      const valueCell = (piece.cell() as any).key("value").asSchema({
        type: "number",
      });
      const mock = new MockDoc(
        `<!DOCTYPE html><html><body><div id="root"></div></body></html>`,
      );
      const { document, renderOptions } = mock;
      const root = document.getElementById("root")!;

      const cancel = render(root, piece.cell() as any, renderOptions);

      await waitFor(
        () => Promise.resolve(root.innerHTML.length > 0),
        { timeout: 5000 },
      );
      assertEquals(await valueCell.sync(), 0);

      const button = root.getElementsByTagName("button")[0] as any;
      assertExists(button);

      button.dispatchEvent({ type: "click", target: button });

      await waitFor(
        async () => await valueCell.sync() === 1,
        { timeout: 5000 },
      );

      await waitFor(
        () => Promise.resolve(root.innerHTML.includes(">1</span>")),
        { timeout: 5000 },
      );

      cancel();
    });

    it("dispatches navigateTo from rendered handler streams", async () => {
      const navigatePattern =
        `import { Default, handler, NAME, navigateTo, pattern, UI } from "commonfabric";

interface ChildState {
  label: Default<string, "target">;
}

const Child = pattern<ChildState>(({ label }) => ({
  [NAME]: "Target Child",
  label,
  [UI]: <div id="child">{label}</div>,
}));

const go = handler<void, Record<string, never>>(() => {
  return navigateTo(Child({ label: "target" }));
});

export default pattern<Record<string, never>>(() => {
  return {
    [NAME]: "Navigate Handler Test",
    [UI]: <button id="go" onClick={go({})}>Go</button>,
  };
});`;

      const navigateProgram: Program = {
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: navigatePattern,
        }],
      };

      const session = await createTestSession();
      await using rt = await createRuntimeClient(session);

      const piece = await rt.createPiece(navigateProgram, session.space, {
        run: true,
      });
      const mock = new MockDoc(
        `<!DOCTYPE html><html><body><div id="root"></div></body></html>`,
      );
      const { document, renderOptions } = mock;
      const root = document.getElementById("root")!;

      const navigation = new Promise<string>((resolve) => {
        rt.on("navigaterequest", ({ cell }) => {
          resolve(cell.id());
        });
      });

      const cancel = render(root, piece.cell() as any, renderOptions);

      await waitFor(
        () => Promise.resolve(root.innerHTML.length > 0),
        { timeout: 5000 },
      );

      const button = root.getElementsByTagName("button")[0] as any;
      assertExists(button);

      button.dispatchEvent({ type: "click", target: button });

      let timeout: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<string>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("timed out waiting for navigaterequest")),
          5000,
        );
      });
      const navigatedPieceId = await Promise.race([
        navigation,
        timeoutPromise,
      ]).finally(() => {
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
      });
      assertExists(navigatedPieceId);

      cancel();
    });

    it({
      name:
        "dispatches one navigateTo when a rendered handler changes local state",
      ...onArmStepSkip(
        "dispatches one navigateTo when a rendered handler changes local state",
      ),
      fn: async () => {
        const navigatePattern =
          `import { Default, computed, handler, NAME, navigateTo, pattern, UI, Writable } from "commonfabric";

interface ChildState {
  label: Default<string, "target">;
}

const Child = pattern<ChildState>(({ label }) => ({
  [NAME]: "Target Child",
  label,
  [UI]: <div id="child">{label}</div>,
}));

const go = handler<void, { menuOpen: Writable<boolean> }>((_, { menuOpen }) => {
  menuOpen.set(false);
  return navigateTo(Child({ label: "target" }));
});

export default pattern<Record<string, never>>(() => {
  const menuOpen = new Writable(true);
  return {
    [NAME]: "Navigate Handler State Test",
    menuOpen,
    [UI]: (
      <button
        id="go"
        onClick={go({ menuOpen })}
        style={{ display: computed(() => menuOpen.get() ? "block" : "none") }}
      >
        Go
      </button>
    ),
  };
});`;

        const navigateProgram: Program = {
          main: "/main.tsx",
          files: [{
            name: "/main.tsx",
            contents: navigatePattern,
          }],
        };

        const session = await createTestSession();
        await using rt = await createRuntimeClient(session);

        const piece = await rt.createPiece(navigateProgram, session.space, {
          run: true,
        });
        const mock = new MockDoc(
          `<!DOCTYPE html><html><body><div id="root"></div></body></html>`,
        );
        const { document, renderOptions } = mock;
        const root = document.getElementById("root")!;
        const navigations: string[] = [];
        const gotNavigation = defer<void>();
        rt.on("navigaterequest", ({ cell }) => {
          navigations.push(cell.id());
          if (navigations.length > 0) gotNavigation.resolve();
        });

        const cancel = render(root, piece.cell() as any, renderOptions);

        await waitFor(
          () => Promise.resolve(root.innerHTML.length > 0),
          { timeout: 5000 },
        );

        const button = root.getElementsByTagName("button")[0] as any;
        assertExists(button);

        button.dispatchEvent({ type: "click", target: button });

        await gotNavigation.promise;
        await rt.idle();

        assertEquals(navigations.length, 1);

        cancel();
      },
    });
  });

  describe("CFC render-policy threading (S15)", () => {
    // Guards the field-by-field copy in RuntimeClient.initialize() and the
    // RuntimeProcessor.initialize() -> WorkerReconciler plumbing. An
    // initialize() payload that dropped renderDeclassificationPolicy would
    // make {renderDeclassificationPolicy: "deny"} behave as "allow" (fail
    // open). This exercises the REAL threading end to end: initialize ->
    // worker InitializationData -> RuntimeProcessor -> every mount's
    // reconciler.
    const SECRET_TEXT = "Sensitive diagnosis: migraine";
    const SECRET_ATOM = "s15-threading-secret";
    const BLOCKED_TEXT = "Content hidden by policy";

    // Mount (via the worker renderer) a <cf-cfc-render-boundary> whose author
    // props declassify the label of a confidential cell rendered as its child.
    async function renderAuthorDeclassifiedSecret(
      rt: RuntimeClient,
      space: Session["space"],
    ) {
      const nonce = crypto.randomUUID();
      const secretSchema = {
        type: "string",
        ifc: { confidentiality: [SECRET_ATOM] },
      } as const satisfies JSONSchema;
      const secret = await rt.getCell<string>(
        space,
        "s15-render-policy-secret-" + nonce,
        secretSchema,
      );
      await secret.set(SECRET_TEXT);
      await rt.idle();
      await secret.sync();

      const vdom = await rt.getCell(
        space,
        "s15-render-policy-vdom-" + nonce,
        undefined,
      );
      await vdom.set({
        type: "vnode",
        name: "cf-cfc-render-boundary",
        props: {
          maxConfidentiality: [],
          declassifyConfidentiality: [SECRET_ATOM],
        },
        children: [secret],
      });
      await rt.idle();
      await vdom.sync();

      const mock = new MockDoc(
        `<!DOCTYPE html><html><body><div id="root"></div></body></html>`,
      );
      const { document, renderOptions } = mock;
      const root = document.getElementById("root")!;
      const cancel = render(
        root,
        vdom.asSchema(rendererVDOMSchema) as any,
        renderOptions,
      );
      return { root, cancel };
    }

    it("threads renderDeclassificationPolicy 'deny' through initialize to the worker reconciler", async () => {
      const session = await createTestSession();
      await using rt = await createRuntimeClient(session, {
        renderDeclassificationPolicy: "deny",
      });

      const { root, cancel } = await renderAuthorDeclassifiedSecret(
        rt,
        session.space,
      );
      try {
        // Wait for the blocked placeholder (positive signal) rather than for
        // the absence of the secret, which would pass vacuously pre-render.
        await waitFor(
          () => Promise.resolve(root.innerHTML.includes(BLOCKED_TEXT)),
          { timeout: 10000 },
        );
        assertEquals(
          root.innerHTML.includes(SECRET_TEXT),
          false,
          "deny must ignore the author's declassifyConfidentiality",
        );
      } finally {
        cancel();
      }
    });

    it("absent renderDeclassificationPolicy keeps the 'allow' default (control)", async () => {
      // Same fixtures as the deny case: proves the block above comes from the
      // threaded policy, not from broken fixtures or an always-blocking gate.
      const session = await createTestSession();
      await using rt = await createRuntimeClient(session);

      const { root, cancel } = await renderAuthorDeclassifiedSecret(
        rt,
        session.space,
      );
      try {
        await waitFor(
          () => Promise.resolve(root.innerHTML.includes(SECRET_TEXT)),
          { timeout: 10000 },
        );
        assertEquals(root.innerHTML.includes(BLOCKED_TEXT), false);
      } finally {
        cancel();
      }
    });
  });

  describe("CFC label-metadata seam (inv-12 Stage 0)", () => {
    it('fails closed on the raw meta:"cfc" cell/get seam over real IPC', async () => {
      // `cfc` is not a `MetaField`, but a request arrives as data, so a client
      // can send it. Such a request must get an error response, never the raw
      // label metadata that `getMetaRaw()` would read for it, which includes
      // `Caveat.source`. This drives the REAL worker IPC path (request ->
      // handleCellGet guard -> error response -> rejected promise), not a
      // mocked processor.
      const session = await createTestSession();
      await using rt = await createRuntimeClient(session);

      const cell = await rt.getCell<{ note: string }>(
        session.space,
        "cfc-raw-meta-seam-" + crypto.randomUUID(),
        {
          type: "object",
          properties: { note: { type: "string" } },
        } as const satisfies JSONSchema,
      );
      await cell.set({ note: "labeled" });
      await rt.idle();

      await assertRejects(
        () =>
          rt[$conn]().request<RequestType.CellGet>({
            type: RequestType.CellGet,
            cell: cell.ref(),
            meta: "cfc" as never,
          }),
        Error,
        "cfc",
      );
    });

    it("drops label views from raw sigil links in inbound write values", async () => {
      // A hand-crafted sigil link with a cfcLabelView riding a write value —
      // the raw-link ingress that bypasses the CellRef path. The write must
      // succeed with the link intact; the main-thread view is display
      // freight the worker discards at ingress, so it must not surface as
      // label state on the linked read.
      const session = await createTestSession();
      await using rt = await createRuntimeClient(session);

      const nonce = crypto.randomUUID();
      const target = await rt.getCell<{ note: string }>(
        session.space,
        "cfc-raw-link-target-" + nonce,
        {
          type: "object",
          properties: { note: { type: "string" } },
        } as const satisfies JSONSchema,
      );
      await target.set({ note: "linked" });
      await rt.idle();
      const targetRef = target.ref();

      const holder = await rt.getCell<{ item: unknown }>(
        session.space,
        "cfc-raw-link-holder-" + nonce,
        {
          type: "object",
          properties: { item: { type: "object", additionalProperties: true } },
        } as const satisfies JSONSchema,
      );
      await holder.set({
        item: {
          "/": {
            "link@1": {
              id: targetRef.id,
              space: targetRef.space,
              path: [],
              cfcLabelView: {
                version: 1,
                entries: [{
                  path: [],
                  label: { confidentiality: ["main-thread-claim"] },
                }],
              },
            },
          },
        },
      });
      await rt.idle();

      // The link survives the strip and still resolves to the target value.
      const synced = await holder.sync() as
        | { item: { note?: string } }
        | undefined;
      assertEquals(synced?.item?.note, "linked");
      // And the fabricated main-thread view never became the target's label.
      const label = await target.getCfcLabel();
      assertEquals(
        JSON.stringify(label ?? {}).includes("main-thread-claim"),
        false,
      );
    });
  });

  describe("multi-document attachment", () => {
    // Two documents over one worker's runtime, joined the way a family root's
    // piece joins them: the piece that spawned the worker hands a port across,
    // and the document at the far end attaches to the runtime already running.
    // Everything under here is real -- a real worker, a real backend, real
    // ports -- because what these pin is exactly what a stand-in on either
    // side of the IPC cannot show.

    /**
     * The owner's client and its transport, which is what a port is handed
     * over through. `createRuntimeClient` drops the transport it connects, and
     * these tests need to keep it.
     */
    async function owningClient(session: Session) {
      const transport = await WebWorkerRuntimeTransport.connect();
      const options = await clientOptionsFor(session);
      const client = await RuntimeClient.initialize(transport, options);
      await client.synced(session.space);
      return { client, transport, options };
    }

    /** A second document, attached over a port the owner hands the worker. */
    async function attachingClient(
      owner: { transport: WebWorkerRuntimeTransport },
      options: RuntimeClientOptions,
      overrides: Partial<RuntimeAttachOptions> = {},
    ) {
      const channel = new MessageChannel();
      owner.transport.attachClientPort(channel.port2);
      return await RuntimeClient.attach(
        new MessagePortRuntimeTransport({ port: channel.port1 }),
        { ...attachOptionsFrom(options), ...overrides },
      );
    }

    const counterSchema = {
      type: "object",
      properties: { counter: { type: "number" } },
    } as const satisfies JSONSchema;

    it("feeds both documents from one runtime, and one unsubscribe stops one feed", async () => {
      const session = await createTestSession();
      const owner = await owningClient(session);
      const second = await attachingClient(owner, owner.options);
      try {
        const cause = "multi-document-attachment-" + crypto.randomUUID();
        const first = await owner.client.getCell<{ counter: number }>(
          session.space,
          cause,
          counterSchema,
        );
        const mirror = await second.getCell<{ counter: number }>(
          session.space,
          cause,
          counterSchema,
        );
        await first.set({ counter: 0 });
        await owner.client.idle();
        await mirror.sync();

        // Both documents watch the same cell, and each has a subscription of
        // its own, so one document's unsubscribe leaves the other's feed
        // running.
        const firstSeen: number[] = [];
        const secondSeen: number[] = [];
        const sawOne = defer<void>();
        const cancelFirst = first.subscribe((value) => {
          if (value) firstSeen.push(value.counter);
        });
        const cancelSecond = mirror.subscribe((value) => {
          if (!value) return;
          secondSeen.push(value.counter);
          if (value.counter === 1) sawOne.resolve();
        });

        await first.set({ counter: 1 });
        await sawOne.promise;
        assertEquals(secondSeen.includes(1), true);
        assertEquals(firstSeen.includes(1), true);

        // The first document leaves the cell. The second's feed is its own.
        cancelFirst();
        await owner.client.idle();

        const sawTwo = defer<void>();
        const secondSeenBefore = secondSeen.length;
        const firstSeenBefore = firstSeen.length;
        const watchTwo = mirror.subscribe((value) => {
          if (value?.counter === 2) sawTwo.resolve();
        });
        await first.set({ counter: 2 });
        await sawTwo.promise;

        // The second document heard the write; the first, having left the
        // cell, heard nothing further. A write's echo can arrive behind the
        // local delivery it confirms, so this asks what reached each feed
        // rather than in which order.
        assert(secondSeen.length > secondSeenBefore);
        assertEquals(secondSeen.includes(2), true);
        assertEquals(firstSeen.includes(2), false);
        assertEquals(firstSeen.length, firstSeenBefore);

        watchTwo();
        cancelSecond();
      } finally {
        await second.dispose();
        await owner.client.dispose();
      }
    });

    it("keeps the runtime and the first document running when the second leaves", async () => {
      const session = await createTestSession();
      const owner = await owningClient(session);
      const second = await attachingClient(owner, owner.options);
      const cause = "multi-document-departure-" + crypto.randomUUID();
      try {
        const cell = await owner.client.getCell<{ counter: number }>(
          session.space,
          cause,
          counterSchema,
        );
        await cell.set({ counter: 0 });
        await owner.client.idle();

        const mirror = await second.getCell<{ counter: number }>(
          session.space,
          cause,
          counterSchema,
        );
        const cancelMirror = mirror.subscribe(() => {});
        await second.idle();

        // The second document's departure is its own: its subscription stops,
        // and the runtime it was borrowing keeps serving the first.
        cancelMirror();
        await second.dispose();

        const seen: number[] = [];
        const sawThree = defer<void>();
        const cancel = cell.subscribe((value) => {
          if (!value) return;
          seen.push(value.counter);
          if (value.counter === 3) sawThree.resolve();
        });
        await cell.set({ counter: 3 });
        await sawThree.promise;
        // Membership rather than the last value: a write's echo can arrive
        // behind the local delivery it confirms, so the tail of this list is
        // delivery order and not what the test is about.
        assertEquals(seen.includes(3), true);
        cancel();
      } finally {
        await owner.client.dispose();
      }
    });

    it("refuses a second document asserting a different acting principal", async () => {
      const session = await createTestSession();
      const owner = await owningClient(session);
      try {
        const stranger = await Identity.fromPassphrase(
          "a different operator",
          keyConfig,
        );
        await assertRejects(
          () =>
            attachingClient(owner, owner.options, {
              identity: stranger.did(),
            }),
          Error,
          "Attach refused",
        );
      } finally {
        await owner.client.dispose();
      }
    });
  });
});

async function createTestSession(): Promise<Session> {
  return await createSession({
    identity,
    spaceName: globalThis.crypto.randomUUID(),
  });
}

/**
 * What this process's clients are configured with. A second document attaches
 * by asserting the security half of these, so the two callers build them from
 * one place rather than each stating a posture of its own.
 */
async function clientOptionsFor(
  session: Session,
  extraOptions: Partial<RuntimeClientOptions> = {},
): Promise<RuntimeClientOptions> {
  // If a space identity was created, replace it with a transferrable
  // key in Deno using the same derivation as Session. That derivation supports
  // the legacy space names used during development and nothing else, and is
  // removed once those development-only spaces have been migrated
  // (docs/plans/random-space-identities.md).
  if (session.spaceIdentity && session.spaceName) {
    session.spaceIdentity = await (
      await Identity.fromPassphrase("common user", keyConfig)
    ).derive(session.spaceName, keyConfig);
  }

  return {
    apiUrl: new URL(API_URL),
    identity: session.as,
    spaceIdentity: session.spaceIdentity,
    spaceDid: session.space,
    spaceName: session.spaceName,
    // Workers receive the same environment-selected flags as their host,
    // including explicit false overrides of a client-class default.
    experimental: EXPERIMENTAL,
    ...extraOptions,
  };
}

async function createRuntimeClient(
  session: Session,
  extraOptions: Partial<RuntimeClientOptions> = {},
): Promise<RuntimeClient> {
  const transport = await WebWorkerRuntimeTransport.connect();
  const worker = await RuntimeClient.initialize(
    transport,
    await clientOptionsFor(session, extraOptions),
  );

  await worker.synced(session.space);
  return worker;
}
