/**
 * `read_value` returns the value behind a handle the run holds, once the run
 * has described it: through the release check every value bound for the model
 * passes, with what it read joining the run's model context.
 */

import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import { Runtime } from "@commonfabric/runner";
import { createLLMFriendlyLink } from "@commonfabric/runner/shared";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "../../runner/test/cfc-seed-envelope.ts";
import type { HarnessHandleTable } from "../src/contracts/handle-table.ts";
import { createToolOutputId } from "../src/contracts/tool-result.ts";
import type { HarnessAssistantTranscriptMessage } from "../src/contracts/transcript.ts";
import type { HarnessFabricSession } from "../src/fabric-session.ts";
import {
  createHarnessHandleTable,
  markHandleDescribed,
  mintAddressHandle,
  resolveHandleToken,
} from "../src/handle-table.ts";
import { CfHarnessPromptLoop } from "../src/prompt-loop.ts";
import type { SandboxRuntime } from "../src/sandbox/types.ts";
import { readValueTool } from "../src/tools/read-value.ts";
import type { HarnessToolContext } from "../src/tools/types.ts";
import { directPromptSlotBindingFor } from "./support/prompt-slot-binding.ts";

const signer = await Identity.fromPassphrase("cf-harness read-value");

/** The label the seeded document's `secret` field carries. */
const SECRET_ATOM = "read-value-test-secret";

/** A fabric under `mode`, with persisted flow labels. */
const createFabric = async (
  mode: "observe" | "enforce-strict",
  readCeiling?: readonly string[],
): Promise<{
  runtime: Runtime;
  storage: ReturnType<typeof StorageManager.emulate>;
  session: HarnessFabricSession;
}> => {
  const storage = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("http://toolshed.test"),
    storageManager: storage,
    cfcEnforcementMode: mode,
    cfcFlowLabels: "persist",
    ...(readCeiling !== undefined
      ? { cfcReadMaxConfidentiality: readCeiling }
      : {}),
  });
  const pieces = new PiecesController(
    createSession({
      identity: signer,
      spaceDid: (await Identity.generate()).did(),
    }),
    runtime,
  );
  await pieces.synced();
  return { runtime, storage, session: { pieces } };
};

/**
 * Seeds a document holding unlabelled lanes and a count, a `secret` labelled
 * {@link SECRET_ATOM}, and a link to a second document; returns its address.
 */
const seedDocument = async (
  runtime: Runtime,
  session: HarnessFabricSession,
): Promise<{ ref: string; otherRef: string }> => {
  const space = session.pieces.getSpace();
  const seed = runtime.edit();
  const other = runtime.getCell(space, "read-value-other", undefined, seed);
  other.set({ title: "Review" });
  const cell = runtime.getCell(space, "read-value-source", undefined, seed);
  const id = cell.getAsNormalizedFullLink().id;
  const otherId = other.getAsNormalizedFullLink().id;
  writeSeedEnvelopeDoc(seed, space);
  seedStoredEnvelope(seed, { space, scope: "space", id, path: [] }, {
    value: {
      lanes: ["kick", "snare"],
      count: 3,
      secret: "the vault code is 4417",
      item: { "/": { "link@1": { id: otherId, path: [] } } },
    },
    cfc: {
      version: 1,
      schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
      labelMap: {
        version: 1,
        entries: [{
          path: ["secret"],
          label: { confidentiality: [SECRET_ATOM] },
        }],
      },
    },
  });
  expect((await seed.commit().settled).ok).toBeDefined();
  return {
    ref: createLLMFriendlyLink(cell.getAsNormalizedFullLink(), space),
    otherRef: createLLMFriendlyLink(other.getAsNormalizedFullLink(), space),
  };
};

/** The context members `read_value` reads. */
const contextWith = (
  session: HarnessFabricSession,
  table: HarnessHandleTable,
  sideEffectsAuthorized = false,
): HarnessToolContext =>
  ({
    runId: "run-read-value",
    cfcEnforcementMode: "observe",
    sideEffectsAuthorized,
    handleTable: table,
    getFabricSession: () => Promise.resolve(session),
    nextOutputId: (toolId: string) =>
      createToolOutputId("run-read-value", toolId, 1),
  }) as unknown as HarnessToolContext;

/** `ref` held, and described unless `described` is false. */
const held = async (
  ref: string,
  described = true,
): Promise<{ table: HarnessHandleTable; token: string }> => {
  const minted = await mintAddressHandle(
    createHarnessHandleTable("run-read-value"),
    ref,
  );
  return {
    table: described
      ? markHandleDescribed(minted.table, minted.token)
      : minted.table,
    token: minted.token,
  };
};

describe("read-value", () => {
  let fabric: Awaited<ReturnType<typeof createFabric>> | undefined;

  afterEach(async () => {
    await fabric?.runtime.dispose();
    await fabric?.storage.close();
    fabric = undefined;
  });

  describe("readValueTool", () => {
    it("returns the value behind a described handle, strings as text", async () => {
      fabric = await createFabric("observe");
      const { ref } = await seedDocument(fabric.runtime, fabric.session);
      const { table, token } = await held(`${ref}/lanes`);

      const output = await readValueTool.invoke(
        contextWith(fabric.session, table),
        { token: `${ref}/lanes` },
      );

      expect(output).toMatchObject({
        status: "ok",
        token,
        value: ["kick", "snare"],
      });
    });

    it("refuses a handle the run has not described", async () => {
      // Reading is the expensive, tainting step, so it follows a look at the
      // shape rather than replacing it.
      fabric = await createFabric("observe");
      const { ref } = await seedDocument(fabric.runtime, fabric.session);
      const { table } = await held(ref, false);

      const output = await readValueTool.invoke(
        contextWith(fabric.session, table),
        { token: ref },
      );

      expect(output.status).toBe("error");
      expect((output as { message: string }).message).toContain(
        "describe_handle",
      );
    });

    it("refuses an empty token, one the run does not hold, and a path holding nothing", async () => {
      // Each refusal names what was wrong with the reference, never a value.
      fabric = await createFabric("observe");
      const { ref } = await seedDocument(fabric.runtime, fabric.session);
      const { table } = await held(ref);
      const read = (input: { token: string; select?: string }) =>
        readValueTool.invoke(contextWith(fabric!.session, table), input);

      expect(await read({ token: " " })).toMatchObject({
        status: "error",
        message: "read_value requires a handle token",
      });
      expect(await read({ token: "cfh:a:zzzzz" })).toMatchObject({
        status: "error",
        message: "read_value can only read a handle this run holds",
      });
      expect(await read({ token: ref, select: "missing" })).toMatchObject({
        status: "error",
        message: expect.stringContaining("holds nothing at that path"),
      });
    });

    it("refuses a handle whose own space the session was not admitted to", async () => {
      fabric = await createFabric("observe");
      const elsewhere = (await Identity.generate()).did();
      const ref = `//${elsewhere}/of:fid1:read-value-elsewhere`;
      const { table } = await held(ref);

      const output = await readValueTool.invoke(
        contextWith(fabric.session, table),
        { token: ref },
      );

      expect(output).toMatchObject({
        status: "error",
        message: expect.stringContaining("admitted to"),
      });
    });

    it("narrows what it reads to the selected path", async () => {
      fabric = await createFabric("observe");
      const { ref } = await seedDocument(fabric.runtime, fabric.session);
      const { table } = await held(ref);

      const output = await readValueTool.invoke(
        contextWith(fabric.session, table),
        { token: ref, select: "lanes/1" },
      );

      expect(output).toMatchObject({ status: "ok", value: "snare" });
    });

    it("returns a link the value holds as an address rather than a copy", async () => {
      fabric = await createFabric("observe");
      const { ref, otherRef } = await seedDocument(
        fabric.runtime,
        fabric.session,
      );
      const { table } = await held(ref);

      const output = await readValueTool.invoke(
        contextWith(fabric.session, table),
        { token: ref },
      );

      expect(output).toMatchObject({
        status: "ok",
        value: { item: { "@link": otherRef } },
      });
    });

    it("reads through a link at the selected position to the value it names", async () => {
      // A piece's fields are links to the cells that hold them, so reading a
      // field reads what the link names rather than the link.
      fabric = await createFabric("observe");
      const { ref } = await seedDocument(fabric.runtime, fabric.session);
      const { table } = await held(ref);

      const output = await readValueTool.invoke(
        contextWith(fabric.session, table),
        { token: ref, select: "item" },
      );

      expect(output).toMatchObject({
        status: "ok",
        value: { title: "Review" },
      });
    });

    it("refuses a link at the selected position into a space the session was not admitted to", async () => {
      // The handle names this run's own space, and what it links to does not
      // widen the spaces the run may read.
      fabric = await createFabric("observe");
      const space = fabric.session.pieces.getSpace();
      const elsewhere = (await Identity.generate()).did();
      const seedOutside = fabric.runtime.edit();
      const outside = fabric.runtime.getCell(
        elsewhere,
        "read-value-outside",
        undefined,
        seedOutside,
      );
      outside.set({ secret: "kept elsewhere" });
      expect((await seedOutside.commit().settled).ok).toBeDefined();
      const seed = fabric.runtime.edit();
      const holder = fabric.runtime.getCell(
        space,
        "read-value-holder",
        undefined,
        seed,
      );
      holder.set({ away: outside.getAsLink() });
      expect((await seed.commit().settled).ok).toBeDefined();
      const ref = createLLMFriendlyLink(
        holder.getAsNormalizedFullLink(),
        space,
      );
      const { table } = await held(ref);

      const output = await readValueTool.invoke(
        contextWith(fabric.session, table),
        { token: ref, select: "away" },
      );

      expect(output.status).toBe("error");
      expect(JSON.stringify(output)).not.toContain("kept elsewhere");
    });

    it("refuses at the root a value the model may not observe, naming why and the subagent route", async () => {
      fabric = await createFabric("enforce-strict");
      const { ref } = await seedDocument(fabric.runtime, fabric.session);
      const { table } = await held(ref);

      const output = await readValueTool.invoke(
        contextWith(fabric.session, table),
        { token: ref, select: "secret" },
      );

      expect(output.status).toBe("error");
      const message = (output as { message: string }).message;
      expect(message).toContain(SECRET_ATOM);
      expect(message).toContain("delegate_task");
      expect(JSON.stringify(output)).not.toContain("4417");
    });

    it("refuses a value above the session's read ceiling, naming the ceiling", async () => {
      // The read ceiling binds every reader the session runs, subagents
      // included, so this refusal offers no route around it.
      fabric = await createFabric("observe", ["read-value-test-other"]);
      const { ref } = await seedDocument(fabric.runtime, fabric.session);
      const { table } = await held(ref);

      const output = await readValueTool.invoke(
        contextWith(fabric.session, table),
        { token: ref, select: "secret" },
      );

      expect(output.status).toBe("error");
      const message = (output as { message: string }).message;
      expect(message).toContain("above this session's read ceiling");
      expect(message).toContain(SECRET_ATOM);
      expect(message).not.toContain("delegate_task");
      expect(JSON.stringify(output)).not.toContain("4417");
    });

    it("refuses a derived value above the session's read ceiling, naming its label", async () => {
      // A derived document the ceiling withholds is not one nobody derived:
      // the refusal names the label rather than running the piece.
      fabric = await createFabric("observe", ["read-value-test-other"]);
      const space = fabric.session.pieces.getSpace();
      const derivedId = "computed:fid1:read-value-derived";
      const seed = fabric.runtime.edit();
      writeSeedEnvelopeDoc(seed, space);
      seedStoredEnvelope(seed, {
        space,
        scope: "space",
        id: derivedId,
        path: [],
      }, {
        value: { lanes: ["kick"], secret: "the vault code is 4417" },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: ["secret"],
              label: { confidentiality: [SECRET_ATOM] },
            }],
          },
        },
      });
      const holder = fabric.runtime.getCell(
        space,
        "read-value-derived-holder",
        undefined,
        seed,
      );
      holder.set({
        derived: { "/": { "link@1": { id: derivedId, path: [] } } },
      } as never);
      expect((await seed.commit().settled).ok).toBeDefined();
      const ref = createLLMFriendlyLink(
        holder.getAsNormalizedFullLink(),
        space,
      );
      const { table } = await held(ref);

      const output = await readValueTool.invoke(
        contextWith(fabric.session, table, true),
        { token: ref, select: "derived/secret" },
      );

      expect(output.status).toBe("error");
      const message = (output as { message: string }).message;
      expect(message).toContain("above this session's read ceiling");
      expect(message).toContain(SECRET_ATOM);
      expect(JSON.stringify(output)).not.toContain("4417");
    });

    it("reports the label of what it read, where the run's posture releases it", async () => {
      fabric = await createFabric("observe");
      const { ref } = await seedDocument(fabric.runtime, fabric.session);
      const { table } = await held(ref);

      const output = await readValueTool.invoke(
        contextWith(fabric.session, table),
        { token: ref, select: "secret" },
      );

      expect(output).toMatchObject({
        status: "ok",
        value: "the vault code is 4417",
      });
      expect(
        JSON.stringify(
          (output as { cfc?: { observedLabel?: unknown } }).cfc?.observedLabel,
        ),
      ).toContain(SECRET_ATOM);
    });
  });

  describe("on a piece in another space", () => {
    /** A piece whose `rings` field is derived from its argument. */
    const RINGS_PATTERN_SOURCE = [
      "import { computed, Default, pattern, Writable } from 'commonfabric';",
      "interface Ring { id: string; steps: number; }",
      "interface Input { names?: Writable<string[] | Default<['drums', 'bass']>>; }",
      "interface Output { rings: Ring[]; }",
      "export default pattern<Input, Output>(({ names }) => ({",
      "  rings: computed(() => names.get().map((id) => ({ id, steps: 16 }))),",
      "}));",
      "",
    ].join("\n");

    /**
     * A run in its own space admitted to a second one, holding — described —
     * a rings piece set up in the second space and never run there.
     */
    const foreignRings = async (): Promise<{
      session: HarnessFabricSession;
      table: HarnessHandleTable;
      token: string;
      ref: string;
    }> => {
      fabric = await createFabric("observe");
      const neighbour = new PiecesController(
        createSession({
          identity: signer,
          spaceDid: (await Identity.generate()).did(),
        }),
        fabric.runtime,
      );
      await neighbour.synced();
      const created = await neighbour.create(RINGS_PATTERN_SOURCE, {
        input: {},
        start: false,
      });
      const ref =
        `//${neighbour.getSpace()}/${created.getCell().getAsNormalizedFullLink().id}`;
      return {
        session: {
          ...fabric.session,
          foreignSpaces: { [neighbour.getSpace()]: "http://toolshed.test/" },
        },
        ref,
        ...await held(ref),
      };
    };

    /**
     * The handle a whole read of the piece behind `token` hands back for its
     * `rings` field, held and described.
     */
    const derivedHandle = async (
      session: HarnessFabricSession,
      table: HarnessHandleTable,
      token: string,
    ): Promise<{ table: HarnessHandleTable; token: string }> => {
      const whole = await readValueTool.invoke(
        contextWith(session, table, true),
        { token },
      );
      const ref = (whole as { value: { rings: { "@link": string } } })
        .value.rings["@link"];
      const minted = await mintAddressHandle(table, ref);
      return {
        table: markHandleDescribed(minted.table, minted.token),
        token: minted.token,
      };
    };

    it("returns a nested value of a derived field", async () => {
      // The field is derived, so the store holds it only once the piece has
      // run; reading it runs the piece, as calling one of its verbs would.
      const { session, table, token } = await foreignRings();

      const output = await readValueTool.invoke(
        contextWith(session, table, true),
        { token, select: "rings/0/id" },
      );

      expect(output).toMatchObject({ status: "ok", value: "drums" });
    });

    it("refuses a derived field the run is not authorized to run the piece for, naming that the piece has not run", async () => {
      // Running the piece commits what it derives, so it waits on the
      // authorization a side effect needs.
      const { session, table, token } = await foreignRings();

      const output = await readValueTool.invoke(
        contextWith(session, table),
        { token, select: "rings/0/id" },
      );

      expect(output).toMatchObject({
        status: "error",
        message: expect.stringContaining("the piece has not run"),
      });
      expect(JSON.stringify(output)).not.toContain("holds nothing");
    });

    it("refuses a derived field's own handle until its piece has run, naming the piece's handle as the route", async () => {
      // The derived document records no piece, so nothing can run from it,
      // and what it holds is not yet a fact about the path.
      const { session, table, token } = await foreignRings();
      const rings = await derivedHandle(session, table, token);

      const output = await readValueTool.invoke(
        contextWith(session, rings.table, true),
        { token: rings.token, select: "1/id" },
      );

      expect(output).toMatchObject({
        status: "error",
        message: expect.stringContaining("read it through the piece's handle"),
      });
      expect(JSON.stringify(output)).not.toContain("holds nothing");
    });

    it("returns a value under a derived field's own handle once a read has run its piece", async () => {
      const { session, table, token } = await foreignRings();
      const rings = await derivedHandle(session, table, token);
      await readValueTool.invoke(
        contextWith(session, table, true),
        { token, select: "rings" },
      );

      const output = await readValueTool.invoke(
        contextWith(session, rings.table, true),
        { token: rings.token, select: "1/id" },
      );

      expect(output).toMatchObject({ status: "ok", value: "bass" });
    });

    it("says a path the piece does not have holds nothing", async () => {
      const { session, table, token } = await foreignRings();

      const output = await readValueTool.invoke(
        contextWith(session, table, true),
        { token, select: "rings/5/id" },
      );

      expect(output).toMatchObject({
        status: "error",
        message: `${token} holds nothing at that path`,
      });
    });
  });

  describe("at the prompt-loop model boundary", () => {
    it("marks a handle described once described, and taints the run with what it reads", async () => {
      // A scripted model describes the handle, then reads it: the describe is
      // what admits the read, and the read's label joins the model context.
      fabric = await createFabric("observe");
      const { ref } = await seedDocument(fabric.runtime, fabric.session);
      const minted = await mintAddressHandle(
        createHarnessHandleTable("run-read-value-loop"),
        ref,
      );
      const call = (
        name: string,
        input: unknown,
      ): HarnessAssistantTranscriptMessage => ({
        role: "assistant",
        content: "",
        toolCalls: [{
          id: `call-${name}`,
          type: "function",
          function: { name, arguments: JSON.stringify(input) },
        }],
      });
      const steps = [
        call("describe_handle", { token: minted.token }),
        call("read_value", { token: minted.token, select: "secret" }),
      ];
      let turn = 0;
      const artifactRoot = await Deno.makeTempDir();
      try {
        const loop = new CfHarnessPromptLoop({
          sandboxRuntime: {
            describe: () => ({
              kind: "runsc-cfc",
              defaultWorkingDirectory: "/workspace",
              cfc: { runtimeRequested: true, workspaceMountPath: "/workspace" },
            }),
            defaultWorkingDirectory: () => "/workspace",
            resolvePath: (path) => path,
            isPathWithinWorkspace: () => true,
            isPathWithinAllowedRoots: () => true,
            run: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
            runShell: () =>
              Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
          } satisfies SandboxRuntime,
          artifactRoot,
          runId: "run-read-value-loop",
          model: "test-model",
          cfcEnforcementMode: "observe",
          inheritedHandleTable: minted.table,
          fabricSession: {
            apiUrl: "http://toolshed.test",
            identityKeyPath: "/unused/fixture.key",
            space: fabric.session.pieces.getSpace(),
          },
          fabricSessionFactory: () => Promise.resolve(fabric!.session),
          allowedToolIds: ["describe_handle", "read_value"],
          modelClient: {
            providerId: "test-provider",
            complete: () => {
              const assistant = steps[turn] ??
                { role: "assistant" as const, content: "Done." };
              turn += 1;
              return Promise.resolve({ assistant });
            },
          },
        });

        const result = await loop.runPrompt({
          prompt: "read the secret",
          maxModelTurns: 3,
          promptSlotBinding: directPromptSlotBindingFor("read-value"),
        });

        const table = result.runState.handleTable!;
        expect(resolveHandleToken(table, minted.token)?.described).toBe(true);
        expect(JSON.stringify(result.runState.cfcModelContext?.label))
          .toContain(SECRET_ATOM);
      } finally {
        await Deno.remove(artifactRoot, { recursive: true });
      }
    });
  });
});
