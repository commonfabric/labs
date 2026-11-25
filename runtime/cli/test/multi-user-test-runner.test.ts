/**
 * The multi-user orchestrator's `{ label }` / `{ await }` handshake.
 *
 * A marker is a durable write in the shared space, so crossing one means the
 * announcing participant's earlier writes have reached this replica. That is
 * what lets an assertion be read once.
 *
 * What these tests hold in place is that contract as an author meets it: a
 * marker carries state across, a marker announced from a replica that predates
 * another participant's announcement still arrives, a wait outlives a change to
 * the announcer's document that is not the awaited marker, a false assertion is
 * reported for what it read rather than for running out of time, a marker
 * nobody announces is still a deadlock, and an explicit `{ settle: true }` step
 * settles a participant where the author asks for it and the run carries on. The
 * propagation gap itself is too small to observe in a fixture this size — the
 * barrier's discriminating coverage is the pattern-test corpus, where removing
 * it fails seven assertions across `topics`, `lobby`, and `cfc-group-chat-demo`.
 *
 * Also here: a participant's `expectRuntimeErrors` requires its own runtime
 * errors, exactly where it names a count or their messages, and tolerates only
 * those, so one participant's expectation never covers another's errors.
 *
 * And: the CFC enforcement mode a run names reaches every participant.
 * Each participant builds its own runtime in its own worker, so a mode the
 * orchestrator holds and does not forward leaves every one of them on the
 * preset's rung while the run reads as though it named one.
 *
 * And: the requests a participant's worker refuses, the console output it
 * captures, and a press step it runs.
 */

import { expect } from "@std/expect";
import { resolve } from "@std/path";
import { Identity, realmValueFromKeyPair } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { CFC_ENFORCEMENT_MODES } from "@commonfabric/runner/cfc";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { describe, it } from "@commonfabric/test-support/test";
import { runTestPattern, runTests } from "../lib/test-runner.ts";
import {
  assertParticipantRung,
  multiUserDescriptorMeta,
  participantAccess,
  type ParticipantServer,
  ParticipantWorker,
  startParticipantServer,
} from "../lib/multi-user-test-runner.ts";
import type { ParticipantInitResult } from "../lib/multi-user-test-worker.ts";
import { patternTestExperimentalOptions } from "../lib/pattern-test-experimental-options.ts";

const FIXTURES = resolve(import.meta.dirname!, "fixtures/multi-user-markers");
const EDGE_CASES = resolve(
  import.meta.dirname!,
  "fixtures/test-runner-edge-cases",
);

function fixture(name: string): string {
  return resolve(FIXTURES, name);
}

/**
 * A function carrying what a built pattern carries, for a descriptor's
 * participant to name.
 */
const pattern = Object.assign(() => ({}), {
  argumentSchema: {},
  resultSchema: {},
  nodes: [],
});

/**
 * One participant worker, driven by hand over the same request/response
 * protocol the orchestrator uses, beside a server `startParticipantServer()`
 * started, as the orchestrator's are: a worker on the server-execution arm
 * waits for that server's serving loop through it.
 *
 * The orchestrator issues `awaitMarker` only for a marker it has already seen
 * announced, so through it a wait always begins on a marker the announcer has
 * committed and settled — which of the wait's two paths runs is then left to
 * how fast the announcement reaches the awaiting replica. Driving a worker by
 * hand leaves a call in flight while the test drives another worker, which is
 * what lets a test choose the order instead.
 */
function participantWorker(
  name: string,
  server?: ParticipantServer,
): ParticipantWorker {
  // A worker-level failure rejects every pending call with it, so a test
  // reports the error rather than waiting on an answer that will not come.
  const worker: ParticipantWorker = new ParticipantWorker(
    name,
    (error) => void worker.terminate(error),
    server?.servedQuiescence,
  );
  return worker;
}

async function closeWorker(worker: ParticipantWorker): Promise<void> {
  await worker.call("dispose").catch(() => {});
  await worker.terminate();
}

/** The server `cf test` starts for a run at this environment's posture. */
function startServer(): Promise<ParticipantServer> {
  return startParticipantServer(patternTestExperimentalOptions(Deno.env.get));
}

describe(
  "multi-user-test-runner",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("delivers what was written before the marker", async () => {
      const { passed, failed, results } = await runTests(
        fixture("marker-barrier.test.tsx"),
        { root: FIXTURES },
      );
      expect(failed).toBe(0);
      expect(passed).toBe(1);
      expect(results[0].results[0].name).toBe("bob/assertion_1");
    });

    it("runs an explicit settle step for a participant", async () => {
      // `verbose` exercises the per-step logging the orchestrator emits,
      // settle included, so those lines are covered rather than merely run.
      const { passed, failed, results } = await runTests(
        fixture("settle-step.test.tsx"),
        { root: FIXTURES, verbose: true },
      );
      expect(failed).toBe(0);
      expect(passed).toBe(1);
      expect(results[0].results[0].name).toBe("bob/assertion_1");
    });

    it("carries markers announced crosswise", async () => {
      // Each participant announces before crossing the other's marker, from
      // a replica that predates the other's announcement. One marker document
      // per announcer keeps that order conflict-free.
      const { passed, failed } = await runTests(
        fixture("crosswise-markers.test.tsx"),
        { root: FIXTURES },
      );
      expect(failed).toBe(0);
      expect(passed).toBe(2);
    });

    it("reports a false assertion with the operands it read", async () => {
      const { passed, failed, results } = await runTests(
        fixture("false-assertion.test.tsx"),
        { root: FIXTURES },
      );
      expect(passed).toBe(0);
      expect(failed).toBe(1);
      // The assertion is answered from settled state, so the failure names
      // the value that was there rather than reporting elapsed time.
      expect(results[0].results[0].error).toContain(`"from alice"`);
    });

    it("holds a wait open across a change that is not the marker", async () => {
      // The wait re-reads on every change to the announcer's document, so the
      // marker it was given releases it and nothing else does.
      //
      // Driving the workers directly is what orders it that way. The
      // orchestrator announces a marker before it asks anyone to wait for it,
      // so through it the wait's first read decides the outcome. Here bob's
      // wait starts on a marker alice has not been asked for — that request
      // goes out a round trip later — and alice's other marker wakes the wait
      // onto a document that still lacks the one it wants.
      const server = await startServer();
      // This server enforces no ACL, so a DID nothing has written to is a space
      // both participants may use.
      const spaceDid = (await Identity.generate()).did();
      const names = ["alice", "bob"];
      const workers = new Map<string, ParticipantWorker>();
      try {
        for (const [index, name] of names.entries()) {
          const client = participantWorker(name, server);
          workers.set(name, client);
          const identity = await Identity.fromPassphrase(
            `test-runner ${name}`,
            { implementation: "noble" },
          );
          await client.call("init", {
            identity: realmValueFromKeyPair(identity.keyPair),
            spaceDid,
            apiUrl: server.url.href,
            // Any two-participant descriptor will do: the markers this test
            // announces and awaits are its own, not the fixture's steps.
            testPath: fixture("marker-barrier.test.tsx"),
            root: FIXTURES,
            participant: name,
            participants: names,
            seedDefaults: index === 0,
          });
        }
        const alice = workers.get("alice")!;
        const bob = workers.get("bob")!;

        // The outcome is an order rather than a moment: "not released yet" is
        // only worth asserting against something bob has demonstrably seen.
        const order: string[] = [];
        let failure: unknown;
        const waiting = bob.call("awaitMarker", {
          announcedBy: "alice",
          marker: "wanted",
        }).then(() => {
          order.push("released");
        }, (error: unknown) => {
          failure = error;
        });

        await alice.call("label", { marker: "unwanted" });
        // A second wait, for the marker alice did announce, returns once bob's
        // replica holds it — so the first wait has now seen the change that
        // must not release it.
        await bob.call("awaitMarker", {
          announcedBy: "alice",
          marker: "unwanted",
        });
        order.push("saw the other marker");
        expect(failure).toBeUndefined();

        await alice.call("label", { marker: "wanted" });
        await waiting;
        if (failure !== undefined) throw failure;
        expect(order).toEqual(["saw the other marker", "released"]);
      } finally {
        for (const client of workers.values()) await closeWorker(client);
        await server.close().catch(() => {});
      }
    });

    /** One participant's `init`, driven directly so its answer is readable. */
    async function initParticipant(
      server: ParticipantServer,
      args: Record<string, unknown>,
    ): Promise<ParticipantInitResult> {
      const client = participantWorker("alice", server);
      try {
        const identity = await Identity.fromPassphrase("test-runner alice", {
          implementation: "noble",
        });
        return await client.call("init", {
          identity: realmValueFromKeyPair(identity.keyPair),
          spaceDid: (await Identity.generate()).did(),
          apiUrl: server.url.href,
          testPath: fixture("marker-barrier.test.tsx"),
          root: FIXTURES,
          participant: "alice",
          participants: ["alice"],
          seedDefaults: true,
          ...args,
        }) as ParticipantInitResult;
      } finally {
        await closeWorker(client);
      }
    }

    it("runs every participant at the mode the run names", async () => {
      // The rung is checked against what each participant's own runtime
      // answers with, so a mode that reached the orchestrator alone — or
      // reached one worker and not the next — is named rather than run past.

      const { failed, results } = await runTests(
        fixture("marker-barrier.test.tsx"),
        {
          root: FIXTURES,
          cfcEnforcementMode: "observe",
          cfcFlowLabels: "persist",
        },
      );
      expect(results[0].error).toBeUndefined();
      expect(failed).toBe(0);
    });

    it("names the participant that came up on another rung", () => {
      // The check's own report. A worker cannot be made to disagree with the
      // orchestrator from out here, so the message is read from the check
      // rather than from a run that provoked it.

      expect(() =>
        assertParticipantRung("alice", "observe", "enforce-explicit")
      ).toThrow(
        'participant "alice" came up at CFC enforce-explicit, not the ' +
          "observe this run names",
      );
      expect(() => assertParticipantRung("alice", "observe", "observe"))
        .not.toThrow();
      expect(() => assertParticipantRung("alice", undefined, "enforce-strict"))
        .not.toThrow();
    });

    it("builds a participant's runtime at each rung init names", async () => {
      // Every rung, not just a relaxed one: a worker that answered `disabled`
      // whatever it was asked would satisfy a single-rung reading, and
      // `disabled` is the rung that turns CFC off altogether.

      const server = await startServer();
      try {
        for (const rung of CFC_ENFORCEMENT_MODES) {
          const init = await initParticipant(server, {
            cfcEnforcementMode: rung,
          });
          expect(init.cfcEnforcementMode).toBe(rung);
        }
        // Naming none leaves the preset to decide, which is what makes the
        // readings above statements about the request. The rung named here is
        // `runtimePresets.patternTest`'s pin, so a move there lands as a
        // failure in this test rather than as a quietly different harness.
        expect((await initParticipant(server, {})).cfcEnforcementMode)
          .toBe("enforce-strict");
      } finally {
        await server.close().catch(() => {});
      }
    });

    it("builds every requested flow-label mode into the participant runtime", async () => {
      const server = await startServer();
      // Disposal retains both errors if the assertion and shutdown fail.
      await using cleanup = new AsyncDisposableStack();
      cleanup.defer(() => server.close());
      for (const mode of ["off", "observe", "persist"] as const) {
        expect(
          (await initParticipant(server, { cfcFlowLabels: mode }))
            .cfcFlowLabels,
        ).toBe(mode);
      }
      expect((await initParticipant(server, {})).cfcFlowLabels).toBe(
        "persist",
      );
    });

    it(
      "fails a server-execution participant whose server has no serving loop",
      // Only a worker on the server-execution arm asks for the loop, and it
      // resolves its arm from the environment, as the orchestrator does.
      { ignore: !patternTestExperimentalOptions(Deno.env.get).serverExecution },
      async () => {
        // A worker paired with a server started for the other arm waits on
        // the loop at its first settle; the answer names what is missing
        // instead of never arriving.
        const server = await startParticipantServer({});
        try {
          await expect(initParticipant(server, {})).rejects.toThrow(
            "its storage server has no serving loop to wait for",
          );
        } finally {
          await server.close();
        }
      },
    );

    it("rejects an invalid flow-label mode before initializing a participant", async () => {
      const client = participantWorker("alice");
      try {
        await expect(client.call("init", { cfcFlowLabels: "typo" }))
          .rejects.toThrow("cfcFlowLabels is typo");
      } finally {
        await closeWorker(client);
      }
    });

    it("reports a mode that is not on the ladder, naming it", async () => {
      // The name is read before anything else `init` is given, so this needs
      // no space, no server and no test file.

      const client = participantWorker("alice");
      try {
        await expect(
          client.call("init", { cfcEnforcementMode: "enforce-ish" }),
        ).rejects.toThrow(
          "`cfcEnforcementMode` is enforce-ish, not one of ",
        );
      } finally {
        await closeWorker(client);
      }
    });

    it("reports a caller-supplied store on a multi-user test", async () => {
      // The participants instantiate and write in workers of their own, so
      // the caller's store and observer come back empty while their
      // assertions pass. Saying so is what keeps the vintage capture from
      // reading the same run as a pattern that instantiated nothing.
      //
      // On the OFF arm: a run that resolves ON refuses the store before the
      // file is compiled, so it never learns the test is a multi-user one.
      // `test-runner-server-execution.serial.test.ts` checks that refusal.

      const identity = await Identity.fromPassphrase("multi-user storage host");
      const storageManager = StorageManager.emulate({ as: identity });
      try {
        const result = await runTestPattern(
          fixture("marker-barrier.test.tsx"),
          {
            root: FIXTURES,
            storageHost: { identity, storageManager, serverExecution: false },
          },
        );
        expect(result.error).toContain("is a multi-user test");
        expect(result.error).toContain("`storageHost`");
        expect(result.results).toEqual([]);
      } finally {
        await storageManager.close();
      }
    });

    it("writes nothing into a caller-supplied store it refuses", async () => {
      // The single-user runner writes a test's compiled closure into its
      // space, which is the caller's store when one is supplied. A multi-user
      // test is only recognized once compiled, and refuses that store, so the
      // write has to wait until the test is known not to be one.
      //
      // On the OFF arm, for the reason the case above gives: a run that
      // resolves ON refuses the store before it compiles or writes anything.

      const identity = await Identity.fromPassphrase("multi-user untouched");
      const storageManager = StorageManager.emulate({ as: identity });
      const path = fixture("marker-barrier.test.tsx");
      try {
        const result = await runTestPattern(path, {
          root: FIXTURES,
          storageHost: { identity, storageManager, serverExecution: false },
        });
        expect(result.error).toContain("is a multi-user test");

        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager,
        });
        try {
          const program = await resolveLocalProgram(
            (r) => runtime.harness.resolve(r),
            { main: path, root: FIXTURES },
          );
          const evaluated = await runtime.patternManager
            .compileAndRegisterModules(program);
          const entry = [...evaluated.exportsByIdentity!].find((
            [, exports],
          ) => exports === evaluated.main)!;
          const stored = await runtime.patternManager
            .getPatternSourceProgramByIdentity(entry[0], identity.did());
          expect(stored).toBeUndefined();
          await storageManager.synced();
        } finally {
          await runtime.dispose({ closeStorage: false });
        }
      } finally {
        await storageManager.close();
      }
    });

    it("reports a marker nobody announces as a deadlock", async () => {
      const { failed, results } = await runTests(
        fixture("unannounced-marker.test.tsx"),
        { root: FIXTURES },
      );
      expect(failed).toBeGreaterThan(0);
      expect(results[0].error).toContain("Deadlock");
      expect(results[0].error).toContain(`bob awaits "never-announced"`);
    });

    describe("a participant's `expectRuntimeErrors`", () => {
      it("passes a run where each participant raises the runtime errors it expects", async () => {
        const { failed, results } = await runTests(
          fixture("expected-runtime-errors.test.tsx"),
          { root: FIXTURES },
        );
        expect(failed).toBe(0);
        expect(results[0].runtimeErrors).toEqual([]);
      });

      it("fails once for each participant whose expectation goes unmet, naming it", async () => {
        const { failed, results } = await runTests(
          fixture("unmet-runtime-errors.test.tsx"),
          { root: FIXTURES },
        );
        expect(failed).toBe(3);
        expect(results[0].results.map((result) => result.error)).toEqual([
          "[alice] expected 2 runtime error(s), saw 1",
          "[bob] expected some runtime error(s), saw 0",
          "[carol] expected 1 runtime error(s), saw 1; " +
          `none contains "Carol's action is allowed"; ` +
          "unexpected: Error: Carol's action is refused",
        ]);
        expect(results[0].runtimeErrors).toEqual([]);
      });

      it("fails on a runtime error from a participant that expects none, beside one that expects its own", async () => {
        const { failed, results } = await runTests(
          fixture("unexpected-runtime-error.test.tsx"),
          { root: FIXTURES },
        );
        expect(failed).toBe(1);
        expect(results[0].runtimeErrors).toHaveLength(1);
        expect(results[0].runtimeErrors[0]).toContain(
          "[bob] Error: Bob's action is refused",
        );
      });

      it("reports a participant's CFC-refused commit as a warning it allows, not a runtime error", async () => {
        const { passed, failed, results } = await runTests(
          fixture("cfc-refusal-warning.test.tsx"),
          { root: FIXTURES },
        );
        expect(results[0].runtimeErrors).toEqual([]);
        expect(failed).toBe(0);
        expect(passed).toBe(1);
      });

      it("fails a run where a participant's expectation is malformed, naming the value", async () => {
        const { failed, results } = await runTests(
          fixture("malformed-runtime-errors.test.tsx"),
          { root: FIXTURES },
        );
        expect(failed).toBe(1);
        expect(results[0].error).toContain(
          "`expectRuntimeErrors` is `true`, a positive whole count, or a non-empty list of strings, not",
        );
        expect(results[0].error).toContain("1.5");
      });
    });

    describe("the shared space's access list", () => {
      it("returns `OWNER` for the first participant's user and `WRITE` for an undeclared one", () => {
        expect(participantAccess([
          { name: "alice", user: "alice" },
          { name: "bob", user: "bob" },
        ])).toEqual(new Map([["alice", "OWNER"], ["bob", "WRITE"]]));
      });

      it("returns each level a user's participants declare, `none` included", () => {
        expect(participantAccess([
          { name: "alice", user: "alice" },
          { name: "bob", user: "bob", access: "READ" },
          { name: "bobAgain", user: "bob" },
          { name: "carol", user: "carol", access: "none" },
          { name: "dave", user: "dave", access: "OWNER" },
        ])).toEqual(
          new Map([
            ["alice", "OWNER"],
            ["bob", "READ"],
            ["carol", "none"],
            ["dave", "OWNER"],
          ]),
        );
      });

      it("throws when the first participant's user declares a level other than `OWNER`", () => {
        expect(() =>
          participantAccess([
            { name: "alice", user: "alice" },
            { name: "aliceAgain", user: "alice", access: "WRITE" },
          ])
        ).toThrow("so it cannot declare access `WRITE`");
      });

      it("throws when two participants of one user declare different levels", () => {
        expect(() =>
          participantAccess([
            { name: "alice", user: "alice" },
            { name: "bob", user: "bob", access: "READ" },
            { name: "bobAgain", user: "bob", access: "WRITE" },
          ])
        ).toThrow("declare access both `READ` and `WRITE`");
      });

      it("reads a participant's declared `access` from the descriptor", () => {
        expect(multiUserDescriptorMeta({
          participants: {
            alice: pattern,
            bob: { pattern, access: "none" },
          },
        })).toEqual({
          participants: [
            { name: "alice", user: "alice" },
            { name: "bob", user: "bob", access: "none" },
          ],
        });
      });

      it("throws on a declared `access` that is not a level", () => {
        expect(() =>
          multiUserDescriptorMeta({
            participants: { bob: { pattern, access: "ADMIN" } },
          })
        ).toThrow('Participant `bob` declares access `"ADMIN"`');
      });
    });

    describe("a request a participant's worker cannot serve", () => {
      it("refuses a command it does not know, naming it", async () => {
        const worker = participantWorker("alice");
        try {
          await expect(worker.call("bogus")).rejects.toThrow(
            '[alice] unknown command "bogus"',
          );
        } finally {
          await closeWorker(worker);
        }
      });

      it("refuses a step before `init`", async () => {
        const worker = participantWorker("alice");
        try {
          await expect(worker.call("label", { marker: "early" })).rejects
            .toThrow("worker not initialized");
        } finally {
          await closeWorker(worker);
        }
      });

      it("refuses to start a participant the descriptor does not name, and to wait on a participant's markers it was not told of", async () => {
        const server = await startServer();
        await using cleanup = new AsyncDisposableStack();
        cleanup.defer(() => server.close());
        const identity = await Identity.fromPassphrase("test-runner alice", {
          implementation: "noble",
        });
        const init = (participant: string) => ({
          identity: realmValueFromKeyPair(identity.keyPair),
          spaceDid: identity.did(),
          apiUrl: server.url.href,
          testPath: resolve(FIXTURES, "marker-barrier.test.tsx"),
          root: FIXTURES,
          participant,
          participants: [participant],
          seedDefaults: true,
        });

        const carol = participantWorker("carol", server);
        cleanup.defer(() => closeWorker(carol));
        await expect(carol.call("init", init("carol"))).rejects.toThrow(
          'No participant pattern "carol" in test descriptor',
        );

        const alice = participantWorker("alice", server);
        cleanup.defer(() => closeWorker(alice));
        await alice.call("init", init("alice"));
        await expect(
          alice.call("awaitMarker", { announcedBy: "bob", marker: "ready" }),
        ).rejects.toThrow('No marker document for participant "bob"');
      });
    });

    it("reports a participant whose `[TESTS]` is not a list", async () => {
      const { failed, results } = await runTests(
        resolve(EDGE_CASES, "multi-user-tests-not-array.test.tsx"),
        { root: EDGE_CASES },
      );
      expect(failed).toBe(1);
      expect(results[0].error).toContain(
        'Participant "alice" must return { [TESTS]: TestStep[] }',
      );
    });

    it("reports a `setup` that is a function but not a pattern", async () => {
      const { failed, results } = await runTests(
        resolve(EDGE_CASES, "multi-user-setup-not-pattern.test.tsx"),
        { root: EDGE_CASES },
      );
      expect(failed).toBe(1);
      expect(results[0].error).toContain(
        "A multi-user test's `setup` must be a pattern function, got a function that is not a pattern",
      );
    });

    it("presses a participant's rendered control, and fails on the console output of its run but not of its module", async () => {
      const { passed, failed, results } = await runTests(
        resolve(EDGE_CASES, "multi-user-console-press.test.tsx"),
        { root: EDGE_CASES },
      );
      expect(results[0].error).toBeUndefined();
      expect(results[0].results.map(({ name, passed }) => ({ name, passed })))
        .toEqual([{ name: "alice/assertion_1", passed: true }]);
      expect(results[0].consoleErrors).toContain(
        "[alice] [console.error] participant console error",
      );
      expect(results[0].consoleWarnings).toContain(
        "[alice] [console.warn] participant console warning",
      );
      expect(
        [...results[0].consoleErrors, ...results[0].consoleWarnings].some((
          line,
        ) => line.includes("participant body output")),
      ).toBe(false);
      expect(passed).toBe(1);
      expect(failed).toBe(2);
    });

    describe("startParticipantServer()", () => {
      it("starts a server that admits a runtime naming instances only for a posture that names them", async () => {
        for (const instanceNames of [true, false]) {
          const server = await startParticipantServer({ instanceNames });
          await using cleanup = new AsyncDisposableStack();
          cleanup.defer(() => server.close());
          const identity = await Identity.fromPassphrase(
            "multi-user-test-runner participants",
          );
          const storageManager = StorageManager.open({
            as: identity,
            memoryHost: server.url,
          });
          cleanup.defer(() => storageManager.close());
          const runtime = new Runtime({
            apiUrl: new URL(import.meta.url),
            storageManager,
            experimental: { instanceNames: true },
          });
          cleanup.defer(() => runtime.dispose());
          await runtime.getCell(identity.did(), "probe").sync();
          const refusal = storageManager.spaceSessionError(identity.did());
          if (instanceNames) expect(refusal).toBeUndefined();
          else expect(String(refusal)).toContain("does not name instances");
        }
      });
    });

    describe("multiUserDescriptorMeta()", () => {
      it("returns `undefined` for a descriptor with a participant that is neither a function nor an entry naming one, and for one without a participants record", () => {
        expect(
          multiUserDescriptorMeta({
            participants: { alice: pattern, bob: { user: "bob" } },
          }),
        ).toBeUndefined();
        expect(multiUserDescriptorMeta({ participants: null })).toBeUndefined();
        expect(multiUserDescriptorMeta({ participants: {} })).toBeUndefined();
      });

      it("returns `undefined` for a participant of neither shape beside one it would otherwise refuse, whichever comes first", () => {
        const refused = [() => {}, { pattern, access: "ADMIN" }];
        for (const alice of refused) {
          expect(
            multiUserDescriptorMeta({ participants: { alice, bob: 5 } }),
          ).toBeUndefined();
          expect(
            multiUserDescriptorMeta({ participants: { bob: 5, alice } }),
          ).toBeUndefined();
        }
      });

      it("returns each participant's name and user for participants that are patterns or entries naming one", () => {
        expect(
          multiUserDescriptorMeta({
            participants: { alice: pattern, bob: { pattern, user: "robert" } },
          }),
        ).toEqual({
          participants: [
            { name: "alice", user: "alice" },
            { name: "bob", user: "robert" },
          ],
        });
      });

      it("throws, naming the participant, for a function that is not a pattern, alone or in an entry", () => {
        expect(() =>
          multiUserDescriptorMeta({ participants: { alice: () => {} } })
        ).toThrow(
          "Participant `alice` must be a pattern function, got a function that is not a pattern",
        );
        expect(() =>
          multiUserDescriptorMeta({
            participants: { alice: pattern, bob: { pattern: () => {} } },
          })
        ).toThrow(
          "Participant `bob` must be a pattern function, got a function that is not a pattern",
        );
      });
    });
  },
);
