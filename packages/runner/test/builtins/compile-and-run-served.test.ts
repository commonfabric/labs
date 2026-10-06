import {
  isUnavailable,
  UNAVAILABLE_PENDING,
  unavailableError,
} from "@commonfabric/data-model/availability";

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { hashOf } from "@commonfabric/data-model";

import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import type { BuiltInCompileAndRunParams } from "commonfabric";

import { compileAndRun } from "../../src/builtins/compile-and-run.ts";
import { enrollRuntimeOwnedStore } from "../../src/builtins/runtime-owned-store.ts";
import type { Cell } from "../../src/cell.ts";
import { readStoredCfcMetadata } from "../../src/cfc/metadata.ts";
import type { CfcEnforcementMode } from "../../src/cfc/types.ts";
import { RUNNER_ACCEPTANCE_EFFECT_KIND } from "../../src/executor/runner-acceptance.ts";
import {
  stampWaveRunContext,
  WaveAccumulator,
  waveSettlementOf,
} from "../../src/executor/wave.ts";
import type { RuntimeProgram } from "../../src/harness/types.ts";
import { MAX_ENFORCEMENT_CFC_OPTIONS } from "../../src/runtime-presets.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "../cfc-seed-envelope.ts";
import { createTrustedBuilder } from "../support/trusted-builder.ts";

/** Public cells retained by the builtin. */
type Outputs = {
  /** Pending compilation or child setup. */
  pending: Cell<boolean>;

  /** Child piece result. */
  result: Cell<unknown>;

  /** Unstructured compile error. */
  error: Cell<string | undefined>;

  /** Structured source diagnostics. */
  errors: Cell<unknown>;
};

/** Constructs a builtin over a real runtime and a distinct durable input cell. */
async function fixture(
  servingPosture: boolean,
  cfcFlowLabels: "off" | "persist" = "off",
  cfcEnforcementMode: CfcEnforcementMode = "enforce-explicit",
) {
  const identity = await Identity.fromPassphrase("served compile unit");
  const storage = StorageManager.emulate({ as: identity });
  const created: Cell<unknown>[] = [];
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
    experimental: { serverExecution: true },
    servingPosture,
    cfcFlowLabels,
    cfcEnforcementMode,
    pieceCreatedCallback: (piece) => created.push(piece),
  });
  const space = identity.did();
  const inputs = runtime.getCell<BuiltInCompileAndRunParams<any>>(
    space,
    "inputs",
  );
  const parent = runtime.getCell(space, "parent");
  // A program's bytes live in a cell of the piece that names them — its
  // argument document, or one of the internal documents its result projects —
  // and the runner enrolls each of those as a store the runtime owns. This
  // cell stands in for that document, so it carries the same claim.
  //
  // The claim decides a verdict once the source carries a label. `run()` puts
  // the program in through `Cell.set`, which gives a plain object sitting in
  // an array a document of its own, so `files[0]` is split out into a child
  // whose id derives from this one's; §8.12.5 route 2 reaches that child
  // through this document's claim, and without it the child is a store no
  // piece owns and no schema declares. That write shape has no production
  // counterpart: a builtin's inputs arrive in an immutable `data:` document
  // that nothing writes to, and a node's output reaches its binding without
  // anchoring anything.
  //
  // The enrollment is deliberately not transactional, so this transaction
  // carries it and nothing else.
  {
    const enrollment = runtime.edit();
    enrollRuntimeOwnedStore(enrollment, parent, inputs);
    enrollment.abort("Enrollment recorded");
  }
  const publication = runtime.getCellFromLink<unknown>({
    ...runtime.getCell(space, "compile-publication").getAsNormalizedFullLink(),
    scope: "user",
  });
  const cause = "served compile unit";
  const cancels: Array<() => void> = [];
  let outputs: Outputs;
  const action = compileAndRun(
    inputs,
    (tx, result) => {
      outputs = result;
      publication.withTx(tx).set(result);
    },
    (cancel) => cancels.push(cancel),
    cause,
    parent,
    runtime,
  );
  await inputs.sync();
  const memo = runtime.getCell<{
    requestHash: string;
    phase: "pending" | "compiled" | "resolved";
  }>(space, { compile: { internal: cause } });
  await memo.sync();
  return {
    runtime,
    storage,
    inputs,
    memo,
    publication,
    action,
    created,
    get outputs() {
      return outputs;
    },
    async run(program: RuntimeProgram) {
      const tx = runtime.edit();
      inputs.withTx(tx).set(program);
      action(tx);
      const hadEffect = tx.getCfcState().outbox.some((effect) =>
        effect.kind !== RUNNER_ACCEPTANCE_EFFECT_KIND
      );
      expect((await tx.commit().settled).error).toBeUndefined();
      await tx.postCommitEffectsSettled();
      return hadEffect;
    },
    async close() {
      for (const cancel of cancels) cancel();
      await runtime.dispose();
      await storage.close();
    },
  };
}

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{ name: "/main.tsx", contents: "export default 1;" }],
};

const SECOND_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{ name: "/main.tsx", contents: "export default 2;" }],
};

/**
 * A compilation the case settles by hand.
 *
 * The rejection carries a handler from the moment the compilation exists. A
 * case that throws before settling its own compilation still runs the
 * `finally` that rejects it, and that rejection is then the promise's first
 * settlement with nobody awaiting it. The unhandled rejection aborts the
 * module: the cases after it never run, and the failure that caused it can go
 * unreported with them.
 */
const deferredCompilation = <T>(): PromiseWithResolvers<T> => {
  const deferred = Promise.withResolvers<T>();
  deferred.promise.catch(() => {});
  return deferred;
};

describe("compile-and-run-served", () => {
  it("publishes resolved links in each acting user's transaction", async () => {
    const f = await fixture(true);
    const bob = await Identity.fromPassphrase("compile publication bob");
    try {
      expect(await f.run({ files: [], main: "" })).toBe(false);

      for (
        const identity of [
          f.runtime.scopeKeyIdentity,
          { principal: bob.did(), sessionId: "bob" },
        ]
      ) {
        const tx = f.runtime.edit();
        tx.tx.scopeKeyIdentity = identity;
        try {
          f.action(tx);
          const publication = f.publication.withTx(tx);
          expect(publication.key("pending").get()).toBe(false);
          expect(publication.key("result").get()).toEqual(
            unavailableError(
              "Compilation requires a main entrypoint and files",
              "invalidInput",
            ),
          );
          expect(publication.key("error").get()).toBeUndefined();
          expect(publication.key("errors").get()).toBeUndefined();
          for (
            const field of ["pending", "result", "error", "errors"] as const
          ) {
            expect(
              publication.key(field).resolveAsCell().getAsNormalizedFullLink(),
            ).toMatchObject(f.outputs[field].getAsNormalizedFullLink());
          }
        } finally {
          tx.abort("Staged user publication inspected");
        }
      }
    } finally {
      await f.close();
    }
  });

  it("leaves client outcomes for the server and launches no compile", async () => {
    const f = await fixture(false);
    const launches: RuntimeProgram[] = [];
    f.runtime.patternManager.compileOrGetPattern = (input) => {
      if (typeof input !== "string") launches.push(input);
      return new Promise<never>(() => {});
    };
    try {
      for (
        const program of [
          PROGRAM,
          { files: [], main: "" },
          { ...PROGRAM, main: "/missing.tsx" },
        ]
      ) {
        expect(await f.run(program)).toBe(false);
        expect(f.outputs.error.get()).toBeUndefined();
        expect(f.outputs.errors.get()).toBeUndefined();
        expect(f.memo.get()).toBeUndefined();
      }
      expect(launches).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it("reports a resolved child to the creation hook once per request", async () => {
    // A client compiles nothing: it reads the outcome the server committed.
    // The seeds below stand in for that commit — the memo naming a request
    // resolved, and the child's own result hidden by the body that ran it.

    const f = await fixture(false);
    try {
      expect(await f.run(PROGRAM)).toBe(false);

      const seed = f.runtime.edit();
      f.outputs.result.withTx(seed).set({});
      f.memo.withTx(seed).set({
        requestHash: hashOf(PROGRAM).toString(),
        phase: "resolved",
      });
      expect((await seed.commit().settled).error).toBeUndefined();

      // Hiding the result is the child body's last act, so a result that is
      // there and not yet hidden is a child still starting up.
      expect(await f.run(PROGRAM)).toBe(false);
      expect(f.created).toEqual([]);

      const hide = f.runtime.edit();
      f.outputs.result.withTx(hide).key("isHidden").set(true);
      expect((await hide.commit().settled).error).toBeUndefined();

      expect(await f.run(PROGRAM)).toBe(false);
      expect(f.created).toHaveLength(1);
      expect(f.created[0].get()).toEqual({ isHidden: true });

      // The same request resolves on every later run, and the child was
      // created once.
      expect(await f.run(PROGRAM)).toBe(false);
      expect(f.created).toHaveLength(1);

      // A different program is a different request, and its child is
      // reported in its turn.
      const replacement = f.runtime.edit();
      f.memo.withTx(replacement).set({
        requestHash: hashOf(SECOND_PROGRAM).toString(),
        phase: "resolved",
      });
      expect((await replacement.commit().settled).error).toBeUndefined();

      expect(await f.run(SECOND_PROGRAM)).toBe(false);
      expect(f.created).toHaveLength(2);
    } finally {
      await f.close();
    }
  });

  it("launches at commit and keeps one unresolved request through repeated runs", async () => {
    const f = await fixture(true);
    const compilation = deferredCompilation<never>();
    let launches = 0;
    f.runtime.patternManager.compileOrGetPattern = () => {
      launches++;
      return compilation.promise;
    };
    try {
      const tx = f.runtime.edit();
      f.inputs.withTx(tx).set(PROGRAM);
      f.action(tx);
      expect(launches).toBe(0);
      expect(tx.getCfcState().writePolicyInputs).toContainEqual({
        kind: "sink-request",
        sink: "compileAndRun",
        effectId: `compileAndRun:${hashOf(PROGRAM)}`,
        request: PROGRAM,
      });
      expect(f.memo.withTx(tx).get()?.requestHash).toBe(
        hashOf(PROGRAM).toString(),
      );
      expect(f.outputs.pending.withTx(tx).get()).toBe(true);
      expect((await tx.commit().settled).error).toBeUndefined();
      await tx.postCommitEffectsSettled();
      expect(launches).toBe(1);
      expect(await f.run(PROGRAM)).toBe(false);
      expect(launches).toBe(1);
      compilation.reject(new Error("controlled compiler failure"));
      await f.runtime.settled();
      expect(f.outputs.pending.get()).toBe(false);
      expect(f.outputs.error.get()).toContain("controlled compiler failure");
      expect(f.memo.get()?.requestHash).toBe(hashOf(PROGRAM).toString());
      expect(f.memo.get()?.phase).toBe("resolved");
      expect(await f.run(PROGRAM)).toBe(false);
      expect(launches).toBe(1);
    } finally {
      await f.close();
    }
  });

  it("refuses a labeled program at the compile request ceiling", async () => {
    const signer = await Identity.fromPassphrase("compile request ceiling");
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      ...MAX_ENFORCEMENT_CFC_OPTIONS,
      cfcEnforcementMode: "enforce-strict",
      cfcSinkMaxConfidentiality: { compileAndRun: [] },
      experimental: { serverExecution: true },
      servingPosture: true,
    });
    let launches = 0;
    runtime.patternManager.compileOrGetPattern = () => {
      launches++;
      return Promise.reject(new Error("Unexpected compiler launch"));
    };
    const refusals: unknown[] = [];
    runtime.scheduler.onError((error) => refusals.push(error));
    const { pattern, Cell: BuilderCell, compileAndRun: compile } =
      createTrustedBuilder(runtime).commonfabric;
    const parent = pattern<Record<string, never>>(() => {
      const contents = BuilderCell.of("export default 1;", {
        type: "string",
        ifc: {
          confidentiality: [{
            type: "https://commonfabric.org/cfc/atom/Caveat",
            kind: "https://commonfabric.org/cfc/concepts/prompt-influence",
            source: "of:compile-private-source",
          }],
        },
      });
      return compile({
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents }],
      });
    });
    try {
      const tx = runtime.edit();
      const result = runtime.getCell(
        signer.did(),
        "compile-ceiling-result",
        parent.resultSchema,
        tx,
      );
      runtime.run(tx, parent, {}, result);
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
      const value = await waitForCellValue(
        runtime,
        result,
        (value) => isUnavailable(value) && value.reason === "error",
      );
      await runtime.settled();
      expect(launches).toBe(0);
      expect(refusals.map(String).join("\n")).toContain(
        "sink-request confidentiality exceeds ceiling for compileAndRun",
      );
      expect(value).toMatchObject({
        reason: "error",
        errorKind: "compile",
        errorMessage: "compileAndRun request was refused before it started",
      });
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("compiles a program whose source carries a confidentiality label", async () => {
    // The companion to the ceiling case above: the same labeled program,
    // released rather than refused, so the path past the sink gate is covered
    // too. Setup reads the labeled source, so its flow join carries that
    // caveat and every store the setup transaction fills is measured against
    // it; each is a store the runtime owns, so §8.12.5 route 2 declares the
    // join on it and the compiler is handed the program.
    const signer = await Identity.fromPassphrase("compile labeled source");
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      ...MAX_ENFORCEMENT_CFC_OPTIONS,
      cfcEnforcementMode: "enforce-strict",
      // The sink releases ungated here; the ceiling case covers the gate.
      cfcSinkMaxConfidentiality: {},
      experimental: { serverExecution: true },
      servingPosture: true,
    });
    let launches = 0;
    runtime.patternManager.compileOrGetPattern = () => {
      launches++;
      return Promise.reject(new Error("labeled source compiler failure"));
    };
    const refusals: unknown[] = [];
    const refused = Promise.withResolvers<void>();
    refused.promise.catch(() => {});
    runtime.scheduler.onError((error) => {
      refusals.push(error);
      refused.resolve();
    });
    const { pattern, Cell: BuilderCell, compileAndRun: compile } =
      createTrustedBuilder(runtime).commonfabric;
    const parent = pattern<Record<string, never>>(() => {
      const contents = BuilderCell.of("export default 1;", {
        type: "string",
        ifc: {
          confidentiality: [{
            type: "https://commonfabric.org/cfc/atom/Caveat",
            kind: "https://commonfabric.org/cfc/concepts/prompt-influence",
            source: "of:compile-labeled-source",
          }],
        },
      });
      return compile({
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents }],
      });
    });
    try {
      const tx = runtime.edit();
      const result = runtime.getCell(
        signer.did(),
        "compile-labeled-result",
        parent.resultSchema,
        tx,
      );
      runtime.run(tx, parent, {}, result);
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
      // Either outcome ends the wait. A refused write never reaches the
      // result cell, so waiting on that cell alone would hang on exactly the
      // regression these assertions are written to name; the scheduler
      // reports the refusal, and a run that reaches the compiler reports
      // nothing.
      await Promise.race([
        waitForCellValue(
          runtime,
          result,
          (value) => isUnavailable(value) && value.reason === "error",
        ),
        refused.promise,
      ]);
      await runtime.settled();
      expect(refusals.map(String).join("\n")).not.toContain("writer-fit");
      expect(launches).toBe(1);
      const value = result.get();
      expect(isUnavailable(value) && value.reason).toBe("error");
      expect(isUnavailable(value) && value.errorMessage).toContain(
        "labeled source compiler failure",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("reissues a recovered compilation before consulting the process cache", async () => {
    const f = await fixture(true);
    const compilation = deferredCompilation<never>();
    const spaces: unknown[] = [];
    f.runtime.patternManager.compileOrGetPattern = (_input, space) => {
      spaces.push(space);
      return compilation.promise;
    };
    f.runtime.patternManager.getCompiledPatternForProgramSync = () => {
      throw new Error("Cache lookup preceded the target-space compile request");
    };
    try {
      const seed = f.runtime.edit();
      const hash = hashOf(PROGRAM).toString();
      f.inputs.withTx(seed).set(PROGRAM);
      f.memo.withTx(seed).set({ requestHash: hash, phase: "compiled" });
      expect((await seed.commit().settled).error).toBeUndefined();

      expect(await f.run(PROGRAM)).toBe(true);
      expect(spaces).toEqual([f.inputs.space]);
      expect(f.memo.get()?.phase).toBe("pending");
      compilation.reject(new Error("controlled recovery failure"));
      await f.runtime.settled();
      expect(f.outputs.error.get()).toContain("controlled recovery failure");
    } finally {
      await f.close();
    }
  });

  it("reissues a recovered pending request after its sealed wave is withdrawn", async () => {
    const f = await fixture(true);
    const compilation = deferredCompilation<never>();
    let launches = 0;
    f.runtime.patternManager.compileOrGetPattern = () => {
      launches++;
      return compilation.promise;
    };
    const wave = new WaveAccumulator({
      space: f.inputs.space,
      // An abandoned wave never consults its commit basis sequence.
      basisSeq: 0,
      scopeKeyIdentity: f.runtime.scopeKeyIdentity,
      replicaFor: (space) => f.storage.open(space).replica,
    });
    try {
      const hash = hashOf(PROGRAM).toString();
      const seed = f.runtime.edit();
      f.inputs.withTx(seed).set(PROGRAM);
      f.memo.withTx(seed).set({ requestHash: hash, phase: "pending" });
      expect((await seed.commit().settled).error).toBeUndefined();

      const deferredRequests: Array<() => Promise<void>> = [];
      f.runtime.installSealDestination({
        seal: (tx) => wave.seal(tx),
        deferSealedEffects: (committed, effects) => {
          for (const effect of effects) {
            if (effect.kind === RUNNER_ACCEPTANCE_EFFECT_KIND) continue;
            deferredRequests.push(async () => {
              await effect.flush(committed);
            });
          }
          return true;
        },
      });
      const tx = f.runtime.edit();
      stampWaveRunContext(tx, {
        actionId: "recover-compile-request",
        kind: "derivation",
      });
      f.action(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
      expect(deferredRequests).toHaveLength(1);
      expect(launches).toBe(0);
      const settlement = waveSettlementOf(tx);
      expect(settlement).toBeDefined();

      f.runtime.clearSealDestination();
      wave.abandon("Retry the recovered request in a new wave");
      expect((await settlement)?.error).toBeDefined();
      await wave.settled();
      expect(f.memo.get()).toEqual({ requestHash: hash, phase: "pending" });
      await deferredRequests[0]();
      expect(launches).toBe(0);
      await f.runtime.settled();

      expect(await f.run(PROGRAM)).toBe(true);
      expect(launches).toBe(1);
      expect(await f.run(PROGRAM)).toBe(false);
      expect(launches).toBe(1);
      compilation.reject(new Error("controlled retry completion"));
      await f.runtime.settled();
      expect(f.outputs.pending.get()).toBe(false);
      expect(f.outputs.error.get()).toContain("controlled retry completion");
    } finally {
      f.runtime.clearSealDestination();
      wave.abandon("Test finished");
      await wave.settled();
      await f.close();
    }
  });

  it("reports abandoned compilation without launching the compiler", async () => {
    const f = await fixture(true);
    let launches = 0;
    f.runtime.patternManager.compileOrGetPattern = () => {
      launches++;
      return new Promise<never>(() => {});
    };
    try {
      const seed = f.runtime.edit();
      f.inputs.withTx(seed).set(PROGRAM);
      expect((await seed.commit().settled).error).toBeUndefined();
      const tx = f.runtime.edit();
      f.action(tx);
      const refusal = {
        name: "StorageTransactionAborted",
        message: "Controlled request refusal",
        reason: "Controlled request refusal",
      } as const;
      tx.abort(refusal);
      tx.abandonStagedWork(refusal);
      await f.runtime.settled();
      expect(launches).toBe(0);
      expect(f.outputs.pending.get()).toBe(false);
      expect(f.outputs.error.get()).toBe(
        "compileAndRun request was refused before it started",
      );
      expect(f.outputs.result.get()).toMatchObject({
        reason: "error",
        errorKind: "compile",
        errorMessage: "compileAndRun request was refused before it started",
      });
      expect(f.memo.get()?.requestHash).toBe(hashOf(PROGRAM).toString());
      expect(f.memo.get()?.phase).toBe("resolved");
    } finally {
      await f.close();
    }
  });

  it("completes the accepted request before the next input derivation", async () => {
    const f = await fixture(true);
    const child = createTrustedBuilder(f.runtime).commonfabric.pattern(
      () => ({ answer: 1 }),
    );
    const compilation = deferredCompilation<typeof child>();
    f.runtime.patternManager.compileOrGetPattern = () => compilation.promise;
    try {
      expect(await f.run(PROGRAM)).toBe(true);
      const empty = { files: [], main: "" };
      const edit = f.runtime.edit();
      f.inputs.withTx(edit).set(empty);
      expect((await edit.commit().settled).error).toBeUndefined();

      compilation.resolve(child);
      await f.runtime.settled();
      expect(f.memo.get()).toEqual({
        requestHash: hashOf(PROGRAM).toString(),
        phase: "compiled",
      });
      expect(f.outputs.pending.get()).toBe(true);
      expect(f.outputs.result.get()).toEqual(UNAVAILABLE_PENDING);

      expect(await f.run(empty)).toBe(false);
      expect(f.memo.get()).toEqual({
        requestHash: hashOf(empty).toString(),
        phase: "resolved",
      });
      expect(f.outputs.pending.get()).toBe(false);
      expect(f.outputs.result.get()).toMatchObject({
        reason: "error",
        errorKind: "invalidInput",
      });
    } finally {
      await f.close();
    }
  });

  for (
    const [name, extra] of [
      ["without attachments", {}],
      ["with an empty attachment list", { dataFiles: [] }],
      ["with retained attachment paths", { dataFiles: ["/data.json"] }],
    ] satisfies Array<[string, Pick<RuntimeProgram, "dataFiles">]>
  ) {
    it(`clears a compiled child ${name}`, async () => {
      const f = await fixture(true);
      const child = createTrustedBuilder(f.runtime).commonfabric.pattern(
        () => ({ answer: 1 }),
      );
      const compilation = deferredCompilation<typeof child>();
      f.runtime.patternManager.compileOrGetPattern = () => compilation.promise;
      f.runtime.patternManager.getCompiledPatternForProgramSync = () => child;
      try {
        expect(await f.run(PROGRAM)).toBe(true);
        compilation.resolve(child);
        await f.runtime.settled();
        expect(f.memo.get()?.phase).toBe("compiled");
        expect(await f.run(PROGRAM)).toBe(false);
        await f.runtime.settled();
        expect(await f.outputs.result.pull()).toEqual({
          answer: 1,
          isHidden: true,
        });
        expect(f.memo.get()?.phase).toBe("resolved");
        const empty = { files: [], main: "", ...extra };
        const edit = f.runtime.edit();
        f.inputs.withTx(edit).set(empty);
        expect((await edit.commit().settled).error).toBeUndefined();
        expect(f.inputs.get()).toEqual(empty);
        expect(await f.run(empty)).toBe(false);
        expect(f.outputs.pending.get()).toBe(false);
        expect(f.outputs.result.get()).toEqual(
          unavailableError(
            "Compilation requires a main entrypoint and files",
            "invalidInput",
          ),
        );
        expect(f.memo.get()).toEqual({
          requestHash: hashOf(empty).toString(),
          phase: "resolved",
        });
      } finally {
        await f.close();
      }
    });
  }

  it("preserves an accepted request while its source list is incomplete", async () => {
    const f = await fixture(true);
    const child = createTrustedBuilder(f.runtime).commonfabric.pattern(() => ({
      answer: 1,
    }));
    f.runtime.patternManager.compileOrGetPattern = () => Promise.resolve(child);
    try {
      expect(await f.run(PROGRAM)).toBe(true);
      await f.runtime.settled();
      const memo = f.memo.get();
      expect(await f.run({ files: [], main: "/main.tsx", dataFiles: [] })).toBe(
        false,
      );
      expect(f.memo.get()).toEqual(memo);
      expect(f.outputs.pending.get()).toBe(true);
    } finally {
      await f.close();
    }
  });

  it("ignores a superseded completion and reports its retirement", async () => {
    const f = await fixture(true);
    const compilation = deferredCompilation<never>();
    const events: string[] = [];
    f.runtime.effectMemoObserver = (event) => events.push(event.kind);
    f.runtime.patternManager.compileOrGetPattern = () => compilation.promise;
    try {
      expect(await f.run(PROGRAM)).toBe(true);
      const empty = { files: [], main: "" };
      expect(await f.run(empty)).toBe(false);
      compilation.reject(new Error("superseded error"));
      await f.runtime.settled();
      expect(f.outputs.error.get()).toBeUndefined();
      expect(f.outputs.pending.get()).toBe(false);
      expect(f.memo.get()?.requestHash).toBe(hashOf(empty).toString());
      expect(f.memo.get()?.phase).toBe("resolved");
      expect(events).toEqual(["superseded"]);
    } finally {
      await f.close();
    }
  });

  it("settles an accepted request after a newer sealed request is withdrawn", async () => {
    const f = await fixture(true);
    const compilation = deferredCompilation<never>();
    let completion: Promise<unknown> | undefined;
    let launches = 0;
    f.runtime.asyncWorkObserver = (work) => completion = work;
    f.runtime.patternManager.compileOrGetPattern = () => {
      launches++;
      return compilation.promise;
    };
    const wave = new WaveAccumulator({
      space: f.inputs.space,
      // This contribution is withdrawn without reaching the engine.
      basisSeq: 0,
      scopeKeyIdentity: f.runtime.scopeKeyIdentity,
      replicaFor: (space) => f.storage.open(space).replica,
    });
    try {
      expect(await f.run(PROGRAM)).toBe(true);
      expect(launches).toBe(1);
      expect(completion).toBeDefined();

      const newer = {
        ...PROGRAM,
        files: [{ name: "/main.tsx", contents: "export default 2;" }],
      };
      f.runtime.installSealDestination({
        seal: (tx) => wave.seal(tx),
        deferSealedEffects: () => true,
      });
      const tx = f.runtime.edit();
      stampWaveRunContext(tx, {
        actionId: "stage-newer-compile-request",
        kind: "derivation",
      });
      f.inputs.withTx(tx).set(newer);
      f.action(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
      const settlement = waveSettlementOf(tx);
      expect(settlement).toBeDefined();
      expect(f.memo.get()?.requestHash).toBe(hashOf(newer).toString());
      expect(launches).toBe(1);

      f.runtime.clearSealDestination();
      compilation.reject(new Error("accepted request compiler failure"));
      await completion;
      wave.abandon("The newer request is withdrawn");
      expect((await settlement)?.error).toBeDefined();
      await wave.settled();
      expect(f.memo.get()?.requestHash).toBe(hashOf(PROGRAM).toString());

      await f.run(PROGRAM);
      await f.runtime.settled();
      expect(f.outputs.pending.get()).toBe(false);
      expect(f.outputs.error.get()).toContain(
        "accepted request compiler failure",
      );
      expect(f.memo.get()?.requestHash).toBe(hashOf(PROGRAM).toString());
      expect(f.memo.get()?.phase).toBe("resolved");
    } finally {
      compilation.reject(new Error("Test finished"));
      f.runtime.clearSealDestination();
      wave.abandon("Test finished");
      await wave.settled();
      await f.close();
    }
  });

  it("inherits source labels added while an accepted compile is pending", async () => {
    const f = await fixture(true, "persist", "enforce-strict");
    const compilation = deferredCompilation<never>();
    f.runtime.patternManager.compileOrGetPattern = () => compilation.promise;

    /** Replaces the source's metadata while preserving the program bytes. */
    const writeSourceLabels = async (atoms: string[]) => {
      const tx = f.runtime.edit();
      writeSeedEnvelopeDoc(tx, f.inputs.space);
      seedStoredEnvelope(tx, {
        space: f.inputs.space,
        scope: "space",
        id: f.inputs.getAsNormalizedFullLink().id,
        path: [],
      }, {
        value: PROGRAM,
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: ["files", "0", "contents"],
              label: { confidentiality: atoms },
              origin: "derived",
            }],
          },
        },
      });
      expect((await tx.commit().settled).error).toBeUndefined();
    };

    /** Reads the confidentiality stored on the builtin's durable state. */
    const confidentiality = (cell: Cell<unknown>) => {
      const tx = f.runtime.edit();
      try {
        const link = cell.getAsNormalizedFullLink();
        const metadata = readStoredCfcMetadata(tx, {
          space: link.space,
          id: link.id,
        });
        return (metadata?.labelMap.entries ?? []).flatMap((entry) =>
          entry.label.confidentiality ?? []
        );
      } finally {
        tx.abort("Label inspection complete");
      }
    };

    try {
      await writeSourceLabels(["initial-source-label"]);
      expect(await f.run(PROGRAM)).toBe(true);
      expect(confidentiality(f.memo)).toContain("initial-source-label");
      await writeSourceLabels(["initial-source-label", "late-source-label"]);
      compilation.reject(new Error("labeled compiler failure"));
      await f.runtime.settled();
      expect(f.outputs.error.get()).toContain("labeled compiler failure");
      expect(confidentiality(f.outputs.error)).toContain(
        "initial-source-label",
      );
      expect(confidentiality(f.outputs.error)).toContain("late-source-label");
    } finally {
      compilation.reject(new Error("Test finished"));
      await f.close();
    }
  });
});
