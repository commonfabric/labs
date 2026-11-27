/**
 * Which session's read ceiling a served derivation reads under. The
 * SpaceServer runs a derivation once per demanded INSTANCE, resolving it
 * against one demander's (principal, session) pair. A shared instance acts
 * as no session (serving-loop.md §3c: a derivation acts as the scope it
 * discovers, and a space node demanded by anyone carries no actor), so the
 * ceiling of whichever session happened to demand it must not decide what
 * the shared result is. A bounded session still cannot read the result:
 * its own read of the derived value meets its ceiling.
 *
 * The shape that found it: a pattern's `computed` over labeled rows, first
 * demanded by an agent run whose session declared a narrow ceiling, threw
 * `CfcReadCeilingError` on the serving runtime, and no reader ever got the
 * result.
 */

import { expect } from "@std/expect";

import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import { describe, it } from "@commonfabric/test-support/test";

import type { Cell, Stream } from "../src/cell.ts";
import { ExecutorHost } from "../src/executor/host.ts";
import { actsAsSession } from "../src/executor/wave.ts";
import { Runtime, type RuntimeOptions } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const owner = await Identity.fromPassphrase("derivation ceiling space");
const service = await Identity.fromPassphrase("derivation ceiling service");
const alice = await Identity.fromPassphrase("derivation ceiling alice");
const bob = await Identity.fromPassphrase("derivation ceiling bob");
const space = owner.did() as MemorySpace;

const cfc = {
  cfcEnforcementMode: "enforce-strict",
  cfcFlowLabels: "persist",
} as const satisfies Partial<RuntimeOptions>;

// The note is readable by bob only; alice's ceiling names alice alone.
const noteSchema = {
  type: "object",
  properties: {
    note: {
      type: "string",
      ifc: {
        confidentiality: [{ type: CFC_ATOM_TYPE.User, subject: bob.did() }],
      },
    },
    copied: { type: "number" },
  },
} as const;

/** The run's own read refused by the ceiling, not the seal's refusal. */
const CEILING_REFUSAL = /^CfcReadCeilingError:/;

type Result = { size: number; copied?: number; copy: Stream<unknown> };

type FixtureOptions = {
  /** Whether the note is shared by the space or held per session. */
  scope?: "space" | "session";
  /** The ceiling alice's session declares; by default she sees herself. */
  aliceSees?: readonly string[];
  /** The serving runtime's CFC dials, by default the bounded runs' own. */
  serving?: Partial<RuntimeOptions>;
};

async function fixture(
  { scope = "space", aliceSees = [alice.did()], serving = cfc }:
    FixtureOptions = {},
) {
  const server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
  const errors: unknown[] = [];
  let reportError!: (error: unknown) => void;
  // The serving scheduler's first error, so a refused run ends the test at
  // once rather than leaving it waiting for a result that never comes.
  const firstError = new Promise<unknown>((resolve) => {
    reportError = resolve;
  });
  const clients: Array<
    { runtime: Runtime; manager: EmulatedStorageManager; cancel?: () => void }
  > = [];
  let host: ExecutorHost | undefined;
  async function close() {
    for (const client of clients) client.cancel?.();
    await host?.close();
    for (const client of clients) {
      try {
        await client.runtime.dispose({ closeStorage: false });
      } finally {
        await client.manager.close();
      }
    }
    await server.close();
  }
  try {
    host = new ExecutorHost({
      server,
      serviceIdentity: service.did(),
      // The host factory contract returns a promise.
      // deno-lint-ignore require-await
      createRuntime: async () => {
        const manager = EmulatedStorageManager.connectTo(server, {
          as: service,
        });
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: manager,
          servingPosture: true,
          experimental: { serverExecution: true },
          ...serving,
        });
        runtime.scheduler.onError((error) => {
          errors.push(error);
          reportError(error);
        });
        return {
          runtime,
          dispose: async () => {
            try {
              await runtime.dispose();
            } catch (error) {
              await manager.close();
              throw error;
            }
          },
        };
      },
      policy: { flushDeadlineMs: 5_000, idleParkMs: 600_000 },
    });
    const open = (
      signer: typeof alice,
      options: Partial<RuntimeOptions> = {},
    ) => {
      const manager = EmulatedStorageManager.connectTo(server, { as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: manager,
        experimental: { serverExecution: true },
        ...cfc,
        ...options,
      });
      const client = {
        runtime,
        manager,
        cancel: undefined as (() => void) | undefined,
      };
      clients.push(client);
      return client;
    };

    // Alice, bounded, sets the piece up and is its only demander until bob
    // joins.
    const first = open(alice, {
      cfcReadMaxConfidentiality: aliceSees.map((subject) => ({
        type: CFC_ATOM_TYPE.User,
        subject,
      })),
    });
    const note = scope === "space"
      ? "Writable<string>"
      : "PerSession<Writable<string>>";
    const pattern = await first.runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: `
import { computed, handler, pattern, PerSession, Stream, Writable } from "commonfabric";
const copy = handler<unknown, { note: ${note}; copied: Writable<number> }>(
  (_event, { note, copied }) => { copied.set(note.get().length); },
);
export default pattern<
  { note: ${note}; copied: Writable<number> },
  { size: number; copied: number; copy: Stream<unknown> }
>(({ note, copied }) => ({
  size: computed(() => note.get().length),
  copied,
  copy: copy({ note, copied }),
}));
`,
      }],
    }, { space });
    const argument = first.runtime.getCell<{ note: string; copied: number }>(
      space,
      "derivation-ceiling-input",
      noteSchema,
    );
    const resultOf = (runtime: Runtime) =>
      runtime.getCell<Result>(
        space,
        "derivation-ceiling-result",
        pattern.resultSchema,
      );
    const result = resultOf(first.runtime);
    await argument.sync();
    await result.sync();
    const start = first.runtime.edit();
    argument.withTx(start).set({ note: "for bob only", copied: 0 });
    first.runtime.run(start, pattern, argument, result);
    expect((await start.commit().settled).error).toBeUndefined();
    first.cancel = result.key("size").sink(() => {});

    return {
      errors,
      firstError,
      stats: () => host!.stats(),
      /** The serving scheduler's first error, or `"quiet"` when the host
       * settled without one, so a run that is not refused ends the test
       * rather than leaving it waiting. */
      async refusal(): Promise<string> {
        await first.runtime.storageManager.synced();
        return await Promise.race([
          firstError.then(String),
          host!.whenQuiescent().then(() => "quiet"),
        ]);
      },
      /** Resolves once the host has nothing left to do. */
      async quiet(): Promise<void> {
        await first.runtime.storageManager.synced();
        await host!.whenQuiescent();
      },
      first: { runtime: first.runtime, result },
      async join(signer: typeof bob): Promise<
        { runtime: Runtime; result: Cell<Result> }
      > {
        const client = open(signer);
        const joined = resultOf(client.runtime);
        await joined.sync();
        client.cancel = joined.key("size").sink(() => {});
        return { runtime: client.runtime, result: joined };
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

describe("executor-derivation-read-ceiling", () => {
  it("runs a shared derivation a bounded session demanded without that session's ceiling", async () => {
    const f = await fixture();
    try {
      const second = await f.join(bob);
      const outcome = await Promise.race([
        waitForCellValue<number>(
          second.runtime,
          second.result.key("size"),
          (value) => typeof value === "number",
        ).then((size) => ({ size })),
        f.firstError.then((error) => ({ error: String(error) })),
      ]);
      expect(outcome).toEqual({ size: "for bob only".length });
      expect(f.errors).toEqual([]);
      // The derived value carries the note's label, so the bounded session
      // that demanded it still cannot read it.
      await f.first.result.sync();
      expect(() => f.first.result.key("size").get()).toThrow(/read ceiling/);
    } finally {
      await f.close();
    }
  });

  it("still reads a handler the bounded session fired under that session's ceiling", async () => {
    const f = await fixture();
    try {
      // The shared derivation alice demanded settles without a refusal, so
      // the refusal below is the handler's.
      await f.quiet();
      expect(f.errors).toEqual([]);
      f.first.result.key("copy").send({});
      expect(await f.refusal()).toMatch(CEILING_REFUSAL);
    } finally {
      await f.close();
    }
  });

  it("reads a session's own instance under its ceiling, refusing a shared first run that turns out to be the session's", async () => {
    const f = await fixture({ scope: "session" });
    try {
      // The node's first run is stamped as a shared instance and reads the
      // bounded session's note; the seal refuses it once it discovers
      // session scope, and the rerun, as the session's instance, is refused
      // by the ceiling.
      expect(await f.refusal()).toMatch(CEILING_REFUSAL);
      expect(f.stats().sessionCeilingRefusals).toBeGreaterThan(0);
    } finally {
      await f.close();
    }
  });

  it("gives a session its own instance once the shared first run is refused, when its ceiling admits the note", async () => {
    const f = await fixture({
      scope: "session",
      aliceSees: [alice.did(), bob.did()],
    });
    try {
      const size = await waitForCellValue<number>(
        f.first.runtime,
        f.first.result.key("size"),
        (value) => typeof value === "number",
      );
      expect(size).toBe("for bob only".length);
      await f.quiet();
      expect(f.stats().sessionCeilingRefusals).toBeGreaterThan(0);
      expect(f.errors).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it("reads a shared derivation under the demanding session's ceiling on a runtime whose writes carry no labels", async () => {
    // Without persisted flow labels the result would not carry the note's
    // label to its readers, so the shared instance must not read past the
    // ceiling.
    const f = await fixture({
      serving: { cfcEnforcementMode: "enforce-strict", cfcFlowLabels: "off" },
    });
    try {
      expect(await f.refusal()).toMatch(CEILING_REFUSAL);
    } finally {
      await f.close();
    }
  });
});

describe("actsAsSession", () => {
  it("binds a handler with a session actor and a session instance, and nothing shared", () => {
    const session = "session:did:key:zA:s1" as const;
    expect(actsAsSession({ kind: "event-handler", acting: { session: "s1" } }))
      .toBe(true);
    expect(actsAsSession({ kind: "event-handler", acting: {} })).toBe(false);
    expect(actsAsSession({ kind: "event-handler" })).toBe(false);
    expect(actsAsSession({ kind: "derivation", actionScopeKey: session }))
      .toBe(true);
    expect(
      actsAsSession({ kind: "derivation", actionScopeKey: "user:did:key:zA" }),
    ).toBe(false);
    expect(actsAsSession({ kind: "derivation", actionScopeKey: "space" }))
      .toBe(false);
    expect(actsAsSession({ kind: "derivation" })).toBe(false);
    expect(actsAsSession({ kind: "bookkeeping", actionScopeKey: session }))
      .toBe(false);
  });
});
