/**
 * The explicit per-phase skip lists of the server-execution v2 ON arm
 * (docs/specs/server-side-execution/testing.md §2). In CI the integration
 * suites run twice: in a default role (flag unset, so the first-party
 * default) and in an opposite role (the inverse selected explicitly in the
 * server, the test processes, and the baked browser shell). Whichever role
 * resolves ON reads these lists; the OFF role never skips.
 *
 * The ON arm skips a test only by listing it here, with the plan phase whose
 * surface it exercises and a reason. The test topology (`tasks/test-topology/`)
 * reads a whole-file entry as a unit the ON suite declares unavailable, and
 * leaves the file out of that suite. A step entry leaves the file in; the file
 * skips that one step itself through `serverExecutionOnStepSkip()`, and the
 * topology declares only that leaf unavailable. An empty list means the ON
 * arm runs the full suite.
 *
 * An entry retires when its phase lands (docs/plans/server-execution-v2.md).
 * `validateServerExecutionOnSkips()` reports an entry that names a missing
 * file, or a step its file does not bind, so the lists cannot go stale
 * unnoticed.
 */

/** The integration suites that run an ON arm (testing.md §1–§2). */
export type ServerExecutionSuite =
  | "patterns"
  | "runner"
  | "runtime-client"
  | "shell";

/** The plan milestone whose landing retires the skip (never "phase-1": the
 * ON arm exists from Phase 1 stage A, so nothing can be waiting on it). */
export type ServerExecutionPhase =
  | "phase-2"
  | "phase-3"
  | "phase-4"
  | "phase-5"
  | "phase-6"
  | "phase-7"
  | "phase-2-followup"
  | "phase-3-followup";

export type ServerExecutionOnSkip = {
  /** Test file, relative to the suite's package root (the directory the
   * suite's `deno test` runs from), e.g. "integration/counter.test.ts". */
  file: string;

  /** The plan phase that, once landed, unskips this file (or step). */
  phase: ServerExecutionPhase;

  /** Why the ON arm cannot run this file (or step) before that phase. */
  reason: string;

  /**
   * The exact name of the one `it()` or step inside `file` that the ON arm
   * skips while the rest of the file runs. The topology keeps the file in
   * the ON suite and declares only this leaf unavailable; the test file
   * itself guards the step with {@link serverExecutionOnStepSkip}, so the
   * guard is bound to this entry (remove the entry and the step runs
   * again), and the validator requires the file to name the step and call
   * the guard. For a one-file suite (runtime-client's
   * `integration/client.test.ts`) this keeps the ON lane's coverage rather
   * than dropping the whole file over one red step.
   */
  step?: string;
};

const SUITE_PACKAGE_DIR: Record<ServerExecutionSuite, string> = {
  patterns: "packages/patterns",
  runner: "packages/runner",
  "runtime-client": "packages/runtime-client",
  shell: "packages/shell",
};

/**
 * The lists themselves. Kept to what stage F's live ON-arm runs actually
 * surfaced: with the serving loop landed the ON arm genuinely SERVES,
 * and CI's ON arm is exactly the plan's mid-Phase-1 local flag flip —
 * server and still-deriving clients CAS-storming, "expected, local-only,
 * fine" (L14), and never a shipped state. Entries name their unskipping
 * phase — never silent filtering anywhere else.
 *
 * History: stage G (2026-08-06) re-justified the two-browsers CFC-gate
 * entry this file had held since stage F and added no skips of its own;
 * Phase 2 RETIRED that entry — the client derivation-commit path is
 * removed by construction, dissolving the two-deriver CAS storm the
 * entry named as its unskipping condition — and ADDED the
 * sx2-serving-loop reproducer of the demand-cycle starvation fork at
 * `phase-2-followup`. Stage P2-F (2026-08-13) RETIRED that entry too:
 * the demand-cycle terminal state with commit-triggered re-arm closed
 * the fork (never-loadable roots park instead of churning per cycle;
 * the load pass runs under the flush deadline), so the surface runs —
 * carrying the in-CI amplification-ratio gate and the witness that a
 * serving tenure settles without following any piece's source origin
 * (verification-coverage.md's closed OW19 row).
 * The OW33-family entries this paragraph tracked have moved (OW33
 * triage, 2026-08-22): the two STEP-level `runtime-client` entries and
 * the `patterns` topics-navigation entry are LIFTED (12/12 and 10/10
 * green at the true ON topology — see each list's comment; the topics
 * lift barriers the test's fid capture and moves the echo-drop smell
 * to verification-coverage.md OW60), and the surviving `runner` entry
 * (`pattern-and-data-persistence`) carries a ROOT-CAUSED reason
 * superseding its UNTRIAGED 2026-08-16 note — the speculation
 * overlay's arrival-witness hole
 * (docs/history/plans/server-execution-v2/optimize/
 * ow33-triage-report.md). The ON arm otherwise runs the full
 * suites; the flip PR lands only once this list is empty again.
 *
 * `lunch-poll-vote` LIFTED by stage-C W3.1 (2026-08-19, tip
 * f250feacd): the gate's blocker — the swatch stall — was root-caused
 * (a diverged speculation layer with no reachable retirement on a
 * quiet space; stage-c/swatch-stall-rootcause.md) and its class fix
 * S1 (the drain-settle quiescence advance, RULED 2026-08-19,
 * protocol.md §4) landed with red-first pins. Lift evidence: 6/6
 * GREEN fresh-store on the ON-built binary at the tip (sha256
 * 53a712cede690b6e…, `No default model available` per run, loads
 * 2.3–3.7, gtimeout 520 s) — totals 3 467–4 334 ms; the stalled step
 * ("both voters' swatches visible") walled at 1 ms in EVERY run — a
 * normal arrival, no 28-s recovery, no timeout; joins honest
 * (confirmed roster, 254–256 ms); events appended/processed 11/12
 * with the one purged LT1 leftover ×4 and 11/11 ×2 (the clicks
 * coalesced — no purge); consequence multiplicity {1:16} in ALL SIX
 * stores (the (α) exactly-once invariant); settleAdvances 10–13 per
 * run (the S1 advance live at quiescence). The earlier entry text
 * (the W2 cascade-echo residual and the OW35 history it carried) is
 * preserved in git history and the register's W2.1/OW43 rows.
 * The history it kept: added by the Phase 7 fixer on the independent
 * review (2026-08-16) for the client-side scheduler-non-settling
 * loop (OW32) whose mechanism fan-out stage B fixed; re-justified by
 * stage-C W3 (2026-08-19) after OW35's close for the W2 cascade-echo
 * residual; its sibling `cfc-group-chat-demo-two-browsers` was
 * un-skipped by fan-out stage B (2026-08-17, 3/3 green).
 */

/**
 * The two-browser gates' Phase-7 reason (the client-side
 * `scheduler-non-settling` loop, verification-coverage.md OW32) RETIRED
 * with fan-out stage B (2026-08-17): the loop's cause — the demand
 * registry dropping identity for space-scoped roots, so every per-user
 * node ran once as the service and the client's speculated per-user
 * instances retired to nothing — is fixed by the per-demander run supply
 * (stage A's arrival gate stays as the backstop). Its text lives in the
 * OW32 row's history; the one remaining two-browser entry below carries
 * that gate's own residual.
 *
 * FIRST ON-LANE CI GATE (2026-08-21, run 32447348664 — the stack's
 * first-ever CI execution, on the land-off PR #6096): the ON pattern
 * lanes found SEVEN real ON red surfaces (every one reproduced locally
 * on the ON-built binary; the OFF lanes untouched; the lunch and chat
 * ON gates PASSED in CI). Root-caused before any entry was added:
 * NO DEMAND HOLE anywhere — the (d′) demand machinery held on every
 * surface it could be observed; each red is a WRITE-PATH defect under
 * ON (a write refused/lost/mislabeled or an action killed at
 * commit-prep), and two of the seven converge on the already-owed
 * OW31/§2b write-authority carriage build. Reports:
 * docs/history/plans/server-execution-v2/stage-c/first-on-ci-gate.md
 * (the gate record + triage table) and
 * docs/history/plans/server-execution-v2/stage-c/on-render-stall-rootcause.md
 * (the three render-stall surfaces, store/log/live-run evidence).
 * The landing posture is skip-and-land: the surfaces below carry honest
 * ON-skip entries with owed register rows (verification-coverage.md §3,
 * OW45–OW53), and they gate the FLIP — whose bar is this list EMPTY —
 * not the land. A ninth family member, cfc-group-chat-demo-multi-runtime,
 * is NOT listed: its CI red was the harness's mixed posture (the
 * self-hosted OFF-arm standalone server refusing ON clients' event
 * appends), fixed by resolving the posture in the harness itself —
 * all 7 steps green on the ON binary with the fix.
 */

export const SERVER_EXECUTION_ON_SKIPS: Record<
  ServerExecutionSuite,
  ServerExecutionOnSkip[]
> = {
  // Phase 2 retired the entry this file held since stage F (the
  // two-browsers CFC gate): the client derivation-commit path is
  // removed by construction, the two-deriver interim's CAS storm with
  // it — the exact unskipping condition the entry named. That gate now
  // runs (and passes) ON.
  // topics-navigation LIFTED by the OW33 triage's review pass
  // (2026-08-22, main 51350077e): the entry's recorded fail-fast red
  // (`missing required property myName` at PiecePropIo.set →
  // validateWriteDestination) did NOT reproduce in 11 true-ON runs, and
  // the residual 2/10 flake was a TEST-POSTURE defect — the beforeAll's
  // unbarriered `topicAt` fid capture reading a pre-arrival `topics`
  // when the client's echo run is dropped (the OW60 echo-drop smell,
  // verification-coverage.md — the board itself was always correct
  // server-side). The capture is now barriered on both created topics
  // being readable (waitForCellValue, the waiting-in-tests non-browser
  // shape). Lift evidence: 10/10 green on the ON-built binary
  // (sha256 68331b3f…, fresh store, posture probed per run) WITH the
  // echo-drop occurring in 2 of the 10 runs and absorbed by the
  // barrier — the exact former 2/10 red mechanism, no longer failing.
  // The product smell the flake used to witness stays tracked as
  // verification-coverage.md OW60, not as a flaky test.
  patterns: [
    // default-app's reload STEP ("should persist and reload every rapidly
    // created notebook note") LIFTED 2026-08-28, and its in-file guard removed
    // with it. The entry's own CHARGE stopped reproducing in either arm: the
    // NAVIGATION half fixed by the L2 ruled PUNT plus the step's id-bound reads
    // (#6448), the a04 WRITE-side mark-without-effects residue by #6459's
    // mark/effects atomicity. Lift evidence, both halves of the ruled
    // local-plus-CI-probe bar (RULED 2026-08-27):
    // (1) LOCAL 10/10 quiet-and-loaded at main 1fc841b6e on one ON-built binary
    //     (sha256 a93047a461c0c4d8…, re-verified per run), fresh store + own
    //     97xx port + ON posture probe per run, ensure defaulting ON, toolshed
    //     self-sourced, LLM masked, gtimeout 600 never approached — 13-14s wall
    //     per run against 313-315s for every red the earlier 2026-08-27
    //     campaign recorded, with pattern-load-error, pattern-swap-setup-error,
    //     deferred-start-catchup, session-remount, load-park,
    //     piece-start-commit-failed, structure-load-stuck and
    //     handlerNotRunDeferrals ALL ZERO (events.appended 14 =
    //     events.processed 14 in all ten).
    // (2) The DIRECT CI UNSKIP PROBE (run 33138358110, ON shard 5, job
    //     98743591519, head 95f313835) ran this exact step with no listed skip
    //     and it PASSED — ok (18s), the whole default-app file green, the
    //     shard's published toolshed log clean across the file's window (4
    //     event-view-lag, nothing else).
    // Shard 5's red was a CO-RESIDENT file, cfc-group-chat-demo.test.ts:133 —
    // not skip-listed, untouched by the probe diff, and 4/6 RED locally at the
    // same head running ALONE. The owner RULED 2026-08-28, over the
    // coordinator's recommendation that the probe proves the UNSKIPPED SURFACE
    // and co-resident debt carries its own accountability: "agreed with your
    // recommendations, proceed". Under that surface reading this entry's bar
    // was fully met by the evidence above. Full chain: verification-coverage.md
    // OW45 (the PHASE 3 block and the LIFT block that follows it).
    // lunch-poll-vote's FILE entry LIFTED 2026-08-28 (the THIRD lift; the
    // list is EMPTY again) — the entry's own stated lift condition met: the
    // OWNER RULED the 3b fork 2026-08-28 ("go with (1) plus the (2-D)
    // kick") and both mechanisms are LANDED red-first. (1) event-driven
    // re-supply: a supply-class replication failure PARKS under the WANTED
    // identity (the dependency's own in a recursion frame) and
    // recordPersistedClosureSpaces re-issues it when a matching supply
    // records — once per persist event, no timers, bounded; at failure
    // registration the fallback map is checked once so a record that
    // landed inside the read window re-issues immediately (review-6502
    // F1-(b)); the failure line is byte-identical and the park/re-issue/
    // heal are loud; genuine absence keeps the loud one-shot, now worded
    // "…and on the next persist event". (2-D) serve-time kick: a cached
    // sidecar pattern served for a space it did not compile into
    // replicates its closure there at page-serve time, so the demanding
    // space's supplier is REGISTERED before any create-profile click and
    // the child replication's strictly-older-ticket await covers the
    // lunch class by registration. Pins:
    // pattern-replication-sibling-race.test.ts steps 7-10 (heal,
    // module-wake, registration-time check, dependency-frame park) +
    // executor-cross-space late-carriage + the wish-side kick's own pins,
    // all watched RED at bare main d569f3722 (those last retired with the
    // process-global sidecar cache they covered); new mutations N1/N2/N3/N3b/N4
    // each independently isolated; the existing kill matrix re-verified
    // cell-for-cell (K1's kill rebound to step 1's zero-failure-lines
    // assertion — the heal would otherwise mask its END-STATE, the F1
    // masking class recreated and closed at design time). Entry history
    // (four geometries mapped on five probe boards; geometries 1-3
    // closed by #6484/#6502) is in git history and
    // verification-coverage.md OW45's lunch blocks — the RULING block
    // records the ruling, the landed mechanism, and what stays open (the
    // cross-replica never-records supplier — heals at the server's first
    // matching persist; the prior-session third-space closure; the
    // recursive-(b) sliver). Lift evidence per the ruled
    // local-plus-CI-probe bar: campaign R 8/8 quiet-and-loaded at this
    // head (fresh store + posture probe per run, ensure defaulting ON,
    // toolshed self-sourced, sha re-verified per run, LLM masked;
    // structureLoadStuck 0; closure-replication-failed 0 — the heal
    // machinery dormant locally, exactly the model), and the lift PR's
    // own ON-lane board as the direct-CI unskip probe (PROBE 6) under
    // the ruled SURFACE reading — a red at that surface restores the
    // entry with the accumulated map and the honest classification.
    // The sqlite identity pair's two FILE entries were LIFTED (OW53
    // CLOSED, 2026-08-22): the sqlite builtins consumed the RUNTIME's
    // ambient identity — the SERVICE, on a serving runtime — where the
    // ruled model carries the RUN's acting principal (serving-loop.md
    // §3c; protocol.md §1). The db-owner mint, the cleared-read hash
    // keying, and the effect flush's reader and writeback identity now
    // consume the run-carried principal (client/OFF byte-identical), so
    // `sqlite-db-owner-multi-runtime` and
    // `sqlite-read-clearance-multi-runtime` both green under the true ON
    // topology (fresh-store gate 5/5 each; verification-coverage.md OW53
    // carries the traces and the lift evidence).
  ],
  // pattern-and-data-persistence LIFTED (the arrival-witness predicate,
  // RULED 2026-08-22 — candidate (B) of the OW33 fork memo, built with
  // red-first pins for both observed arms): the entry's root cause was
  // the speculation overlay's ARRIVAL GATE witnessing arrival as
  // `confirmedSeq(writtenDoc) >= floor`, class-blind — a first-run
  // speculation's computed docs carry an AUTHORED setup cover at
  // exactly the floor seq (the client's own phase-3 setup for the new
  // instance; a prior session's for the resumed one), so the entry
  // retired 40-260 ms before the served value landed and the bare read
  // saw undefined (a rotating ~4/8 flake). The ruled predicate: a
  // cover witnesses STRICTLY ABOVE the floor (any class), or AT the
  // floor only when derived-class; unknown class at the floor fails
  // closed toward the standing echo. Lift evidence: 10/10 green at the
  // true ON topology (ON-built binary sha256 d3ef4a47f4354977…, fresh
  // store per run, posture probed per run — shellServerExecutionDefine
  // "true" + servingLoop present; loads 4.2-6.5; per-run stores show
  // the loop serving, e.g. 13 derived commits in run 7). The register
  // row (verification-coverage.md OW33) and the fork memo carry the
  // ruling and the build.
  runner: [],
  // The two STEP-level entries this list held (the CT-1606 PerUser header
  // render, 3/3 red 2026-08-16; the single-navigateTo dispatch, 1/3 red)
  // were LIFTED by the OW33 triage (2026-08-22, main 51350077e): both
  // steps are GREEN at the true ON topology — ON-built binary
  // (sha256 68331b3f…), fresh store, posture probed per run
  // (`shellServerExecutionDefine === "true"`, `servingLoop` present) —
  // 10/10 full-suite runs with both steps executing (45 steps, 0 failed,
  // every run), plus 2 earlier source-toolshed ON runs (12/12 total).
  // The reds healed with the stack landed since the entries were written
  // (fan-out stage B's per-demander run supply, the OW51 unresolved-input
  // semantics, stage-C's arrival/retirement tuning, OW34 attribution).
  // Evidence: docs/history/plans/server-execution-v2/optimize/
  // ow33-triage-report.md. The in-file `onArmStepSkip` guard stays — it
  // is the binding mechanism for any future step entry and is inert while
  // no entry names it.
  "runtime-client": [],
  shell: [],
};

/**
 * The step-level guard a test FILE calls (see `ServerExecutionOnSkip.step`):
 * the entry for `step` in `file`, or undefined when the ON arm runs it.
 * Callers pass `ignore: serverExecutionOnStepSkip(...) !== undefined` only
 * when the process actually runs the ON posture (they resolve it
 * themselves, env-else-first-party-default — the OFF arm never skips), and
 * log the entry's reason when they skip, so the skip is never silent.
 */
export const serverExecutionOnStepSkip = (
  suite: ServerExecutionSuite,
  file: string,
  step: string,
): ServerExecutionOnSkip | undefined =>
  SERVER_EXECUTION_ON_SKIPS[suite].find((skip) =>
    skip.file === file && skip.step === step
  );

/**
 * Reports each stale or unbound entry in `skipLists`: a duplicate, a file
 * that does not exist, and a step entry whose file does not name the step
 * or never calls {@link serverExecutionOnStepSkip}. An empty result means
 * every entry is live.
 */
export const validateServerExecutionOnSkips = async (
  repoRoot: URL,
  skipLists: Record<
    ServerExecutionSuite,
    ServerExecutionOnSkip[]
  > = SERVER_EXECUTION_ON_SKIPS,
): Promise<string[]> => {
  const problems: string[] = [];
  for (
    const [suite, skips] of Object.entries(skipLists) as [
      ServerExecutionSuite,
      ServerExecutionOnSkip[],
    ][]
  ) {
    const seen = new Set<string>();
    for (const skip of skips) {
      const key = skip.step === undefined
        ? skip.file
        : `${skip.file}\0${skip.step}`;
      if (seen.has(key)) {
        problems.push(
          `${suite}: duplicate skip entry for ${skip.file}` +
            (skip.step === undefined ? "" : ` :: ${skip.step}`),
        );
      }
      seen.add(key);
      const path = new URL(
        `${SUITE_PACKAGE_DIR[suite]}/${skip.file}`,
        repoRoot,
      );
      let contents: string | undefined;
      try {
        contents = await Deno.readTextFile(path);
      } catch {
        problems.push(
          `${suite}: skip entry names a missing file: ${skip.file}`,
        );
      }
      // A step entry must be BOUND: the file names the step and calls the
      // guard, else the entry is decoration and the step silently runs (or
      // a renamed step silently unskips).
      if (skip.step !== undefined && contents !== undefined) {
        if (!contents.includes(skip.step)) {
          problems.push(
            `${suite}: step skip entry names a step ${skip.file} does not ` +
              `contain: ${JSON.stringify(skip.step)}`,
          );
        }
        if (!contents.includes("serverExecutionOnStepSkip(")) {
          problems.push(
            `${suite}: ${skip.file} carries a step skip entry but never ` +
              "calls serverExecutionOnStepSkip — the entry would be decoration",
          );
        }
      }
    }
  }
  return problems;
};
