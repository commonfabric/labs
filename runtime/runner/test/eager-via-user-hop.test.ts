// Server-execution v2 stage F: the eager via-user hop (scopes.md §2's
// MUST, flag-gated). A space→session narrowing writes CHAINED redirects
// — space→user→session, ALWAYS via user, even when discovery or the
// declaration jumps straight to session — so every chain has the one
// uniform shape and a later user-level reader finds a well-formed user
// link to follow. This deliberately DIFFERS from main's one-hop-per-event
// behavior, so the OFF arm is pinned here too: off the flag, a
// space→session narrowing keeps writing exactly ONE hop.

import { assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { createCell } from "../src/cell.ts";
import { parseLink } from "../src/link-utils.ts";

const signer = await Identity.fromPassphrase("eager via-user hop test");
const space = signer.did() as MemorySpace;

const SESSION_SCOPED_SCHEMA = {
  type: "object",
  properties: {
    draft: {
      type: "object",
      properties: { text: { type: "string" } },
      asCell: [{ kind: "cell", scope: "session" }],
    },
  },
} as const;

const run = async (
  serverExecution: boolean,
  probe: (runtime: Runtime) => Promise<void>,
) => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    experimental: { serverExecution },
  });
  try {
    await probe(runtime);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
};

Deno.test("flag ON: a space→session narrowing writes the chained space→user→session redirects", async () => {
  await run(true, async (runtime) => {
    const tx = runtime.edit();
    const cell = runtime.getCell(
      space,
      "via-user-hop-on",
      SESSION_SCOPED_SCHEMA,
      tx,
    );
    cell.set({ draft: { text: "hello" } } as never);
    runtime.prepareTxForCommit(tx);
    await tx.commit().settled;
    await runtime.idle();

    const baseLink = cell.key("draft").getAsNormalizedFullLink();
    const schemaless = createCell<{ draft: { text: string } }>(
      runtime,
      { ...cell.getAsNormalizedFullLink(), schema: undefined },
    );

    // The space slot holds a link to the USER instance (the eager hop) —
    // not straight to session.
    const spaceSlot = parseLink(
      schemaless.key("draft").getRaw({ lastNode: "writeRedirect" }),
      schemaless.key("draft"),
    );
    assertEquals(spaceSlot?.scope, "user");
    assertEquals(spaceSlot?.id, baseLink.id);

    // The user instance holds a link to the SESSION instance.
    const userInstance = createCell<{ text: string }>(
      runtime,
      { ...baseLink, schema: undefined, scope: "user" },
    );
    const userSlot = parseLink(
      userInstance.getRaw({ lastNode: "writeRedirect" }),
      userInstance,
    );
    assertEquals(userSlot?.scope, "session");
    assertEquals(userSlot?.id, baseLink.id);

    // The value lives at the session instance.
    const sessionInstance = createCell<{ text: string }>(
      runtime,
      { ...baseLink, schema: undefined, scope: "session" },
    );
    assertEquals(sessionInstance.getRaw(), { text: "hello" });

    // Reading through the chain from the broad slot resolves the value.
    assertEquals(cell.key("draft").key("text").get() as unknown, "hello");
  });
});

Deno.test("flag OFF: the same narrowing keeps today's ONE hop (space slot links straight to session)", async () => {
  await run(false, async (runtime) => {
    const tx = runtime.edit();
    const cell = runtime.getCell(
      space,
      "via-user-hop-off",
      SESSION_SCOPED_SCHEMA,
      tx,
    );
    cell.set({ draft: { text: "hello" } } as never);
    runtime.prepareTxForCommit(tx);
    await tx.commit().settled;
    await runtime.idle();

    const baseLink = cell.key("draft").getAsNormalizedFullLink();
    const schemaless = createCell<{ draft: { text: string } }>(
      runtime,
      { ...cell.getAsNormalizedFullLink(), schema: undefined },
    );
    const spaceSlot = parseLink(
      schemaless.key("draft").getRaw({ lastNode: "writeRedirect" }),
      schemaless.key("draft"),
    );
    // Today's behavior, byte for byte: one hop, straight to session.
    assertEquals(spaceSlot?.scope, "session");
    // And no user-level link exists.
    const userInstance = createCell<{ text: string }>(
      runtime,
      { ...baseLink, schema: undefined, scope: "user" },
    );
    assertEquals(userInstance.getRaw(), undefined);
  });
});

Deno.test("flag ON: an OMITTED session-scoped property gets the chained eager redirects", async () => {
  await run(true, async (runtime) => {
    const tx = runtime.edit();
    const cell = runtime.getCell(
      space,
      "via-user-hop-eager-on",
      {
        type: "object",
        properties: {
          draft: {
            type: "object",
            properties: { text: { type: "string" } },
            asCell: [{ kind: "cell", scope: "session" }],
          },
          title: { type: "string" },
        },
      } as const,
      tx,
    );
    // Omit the scoped property entirely: the eager path materializes the
    // redirect chain with no content write.
    cell.set({ title: "hello" } as never);
    runtime.prepareTxForCommit(tx);
    await tx.commit().settled;
    await runtime.idle();

    const baseLink = cell.key("draft").getAsNormalizedFullLink();
    const schemaless = createCell<{ draft: { text: string } }>(
      runtime,
      { ...cell.getAsNormalizedFullLink(), schema: undefined },
    );
    const spaceSlot = parseLink(
      schemaless.key("draft").getRaw({ lastNode: "writeRedirect" }),
      schemaless.key("draft"),
    );
    assertEquals(spaceSlot?.scope, "user");
    const userInstance = createCell<{ text: string }>(
      runtime,
      { ...baseLink, schema: undefined, scope: "user" },
    );
    const userSlot = parseLink(
      userInstance.getRaw({ lastNode: "writeRedirect" }),
      userInstance,
    );
    assertEquals(userSlot?.scope, "session");
  });
});

Deno.test("flag ON: a pattern run whose output scope is DISCOVERED session-narrow writes the chained redirects at the result binding (pattern-binding.ts's narrowestReadScope branch — OW12)", async () => {
  await run(true, async (runtime) => {
    // The run's READS discover the narrowing: the computed reads a
    // PerSession cell, the tx's narrowestReadScope ratchet lands on
    // "session", and the RESULT binding write — a space-declared slot —
    // takes pattern-binding.ts's discovered-narrowing branch (the third
    // eager-hop site; the two data-updating.ts shapes are pinned
    // above).
    const compiled = await runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: [
          "import { computed, Default, pattern, PerSession, Writable } from 'commonfabric';",
          "type DraftCell = Writable<string | Default<''>>;",
          "export default pattern<",
          "  { draft: PerSession<DraftCell> },",
          "  { echo: string }",
          ">(({ draft }) => ({",
          "  echo: computed(() => (draft.get() as string | undefined) ?? ''),",
          "}));",
        ].join("\n"),
      }],
    }, { space });
    const argument = runtime.getCell<{ draft: string }>(
      space,
      "ow12-arg",
      compiled.argumentSchema,
    );
    const result = runtime.getCell<{ echo: string }>(
      space,
      "ow12-result",
      compiled.resultSchema,
    );
    {
      const tx = runtime.edit();
      argument.withTx(tx).set({ draft: "narrow me" });
      runtime.prepareTxForCommit(tx);
      await tx.commit().settled;
    }
    {
      const tx = runtime.edit();
      runtime.run(tx, compiled, argument, result);
      runtime.prepareTxForCommit(tx);
      await tx.commit().settled;
    }
    const cancel = result.sink(() => {});
    await runtime.idle();
    cancel();

    // The run's output landed on the COMPUTED's result cell; the
    // pattern result doc's `echo` slot links there at space scope. The
    // discovered-narrowing chain lives at THAT doc: its space slot
    // redirects to the USER instance, the user instance to the SESSION
    // instance, and the value sits at session (scopes.md §2's MUST —
    // ALWAYS via user, even when discovery jumps straight to session).
    const resultLink = result.getAsNormalizedFullLink();
    const schemaless = createCell<{ echo: unknown }>(
      runtime,
      { ...resultLink, schema: undefined },
    );
    const echoLink = parseLink(
      schemaless.key("echo").getRaw(),
      schemaless.key("echo"),
    );
    assertEquals(typeof echoLink?.id, "string");
    const computedLink = {
      space: resultLink.space,
      id: echoLink!.id,
      path: [],
    };
    const computedSpace = createCell<unknown>(
      runtime,
      { ...computedLink, schema: undefined },
    );
    const spaceSlot = parseLink(
      computedSpace.getRaw(),
      computedSpace,
    );
    assertEquals(spaceSlot?.scope, "user");
    // A same-doc redirect may omit the id; when present it names the
    // same doc.
    assertEquals(spaceSlot?.id ?? echoLink!.id, echoLink!.id);
    const userInstance = createCell<unknown>(
      runtime,
      { ...computedLink, schema: undefined, scope: "user" },
    );
    const userSlot = parseLink(
      userInstance.getRaw(),
      userInstance,
    );
    assertEquals(userSlot?.scope, "session");
    assertEquals(userSlot?.id ?? echoLink!.id, echoLink!.id);
    const sessionInstance = createCell<unknown>(
      runtime,
      { ...computedLink, schema: undefined, scope: "session" },
    );
    assertEquals(sessionInstance.getRaw(), "narrow me");
    // Reading through the chain resolves the derived value.
    assertEquals(result.key("echo").get() as unknown, "narrow me");
  });
});

Deno.test("flag ON: rewriting a parent that omits an ALREADY-materialized session property re-enqueues no redirect writes (thread r3731191457 probe)", async () => {
  await run(true, async (runtime) => {
    const schema = {
      type: "object",
      properties: {
        draft: {
          type: "object",
          properties: { text: { type: "string" } },
          asCell: [{ kind: "cell", scope: "session" }],
        },
        title: { type: "string" },
      },
    } as const;
    const tx = runtime.edit();
    const cell = runtime.getCell(
      space,
      "via-user-hop-repeat",
      schema,
      tx,
    );
    cell.set({ title: "first" } as never);
    runtime.prepareTxForCommit(tx);
    await tx.commit().settled;
    await runtime.idle();

    // The chain is materialized. Rewrite the parent, again omitting the
    // scoped property: the eager pass must recognize BOTH redirects as
    // unchanged — a second write-attempt of the same sigil every parent
    // rewrite would be redundant write/reactivity churn.
    const tx2 = runtime.edit();
    const cell2 = runtime.getCell(
      space,
      "via-user-hop-repeat",
      schema,
      tx2,
    );
    cell2.set({ title: "second" } as never);
    runtime.prepareTxForCommit(tx2);
    const log = (tx2.tx as unknown as {
      getReactivityLog: () => { writes: Array<{ id: string; path: string[] }> };
    }).getReactivityLog();
    const draftWrites = log.writes.filter((write) =>
      write.path.length > 0 && write.path[0] === "draft"
    );
    assertEquals(
      draftWrites,
      [],
      "a parent rewrite omitting a materialized scoped property must " +
        "not re-write its redirect chain",
    );
    await tx2.commit().settled;
    await runtime.idle();

    // And the chain still stands.
    const baseLink = cell.key("draft").getAsNormalizedFullLink();
    const schemaless = createCell<{ draft: { text: string } }>(
      runtime,
      { ...cell.getAsNormalizedFullLink(), schema: undefined },
    );
    const spaceSlot = parseLink(
      schemaless.key("draft").getRaw({ lastNode: "writeRedirect" }),
      schemaless.key("draft"),
    );
    assertEquals(spaceSlot?.scope, "user");
    const userInstance = createCell<{ text: string }>(
      runtime,
      { ...baseLink, schema: undefined, scope: "user" },
    );
    const userSlot = parseLink(
      userInstance.getRaw({ lastNode: "writeRedirect" }),
      userInstance,
    );
    assertEquals(userSlot?.scope, "session");
  });
});
