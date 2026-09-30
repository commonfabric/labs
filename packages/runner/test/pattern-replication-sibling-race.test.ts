// The runner's cross-space CHILD replication
// (`replicate(parentSpace -> childSpace)`, issued by the run that creates the
// child) can race the SIBLING replication that is still supplying the parent
// space itself — `compileOrGetPattern`'s content-cache hit fires
// `replicate(cached.space -> parentSpace)` fire-and-forget, and the child
// replication follows within the same handler run. A bare one-shot origin
// read at that point finds the parent empty, throws "source closure
// unavailable in origin space", and nothing re-issues it (the documented
// retry is "the next child creation" — a user creates their profile once):
// the child space never receives its program closure, its demanded roots
// defer `pattern-unloadable` forever, and the profile never renders.
//
// The race is deterministic-by-construction here: the child replication is
// issued synchronously after the sibling, and its origin read is strictly
// less work than the sibling's read-plus-write, so a bare read ALWAYS sees
// the parent space before the sibling writes it. Three mechanisms cover
// the three geometries in which the supplier is at least under way, a
// fourth covers the supplier that has not started, and this file pins all
// four:
//
// - the SIBLING AWAIT: a replication awaits the earlier-registered
//   replications INTO its origin space before reading
//   (registration-ordered tickets — acyclic, event-driven, no timers);
// - the FALLBACK ORIGIN (the parent space never receives the closure AT
//   ALL, because `loadPatternByIdentity` serves the pattern from the
//   in-memory artifact index with no per-space persist when another
//   space's compile warmed it first): on a dry origin the replication
//   retries its read against the spaces this manager durably persisted the
//   entry into — content-addressed, so the copy is byte-identical and the
//   verified read stays fail-closed;
// - the IN-FLIGHT-COMPILE AWAIT (the supplier compile itself is still
//   mid-flight at consult time, so no persist exists anywhere and the
//   fallback map is CORRECTLY dry): on a dry origin AND dry map, the
//   replication awaits a snapshot of the in-flight compile registries once
//   (cold compiles + by-identity loads; never `compileCacheWrites`, its
//   own set), then re-consults; genuine absence still throws the same loud
//   one-shot failure;
// - the PARK (the supplier compile has not STARTED at consult time, so no
//   await can see it): the failure is logged loudly once and the
//   replication parks under the wanted identity, and a later persist
//   record of that identity re-issues it.
//
// Layered-view note (why the race needs a missing SUPPLIER and not a
// wave): a same-runtime compile's E4-awaited write-back into a wave's own
// space is readable through the ordinary read path even before the wave
// commits (executor-wave.ts's layered view), so only a supplier that never
// issued its writes can leave the origin empty. The in-flight sibling and
// the never-persisting index-served flow are exactly those suppliers.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { getLogger, type LogMessage } from "@commonfabric/utils/logger";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import * as Engine from "@commonfabric/memory/v2/engine";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import {
  getCompileCacheRuntimeVersion,
  loadCompiledClosure,
  loadVerifiedSourceClosure,
} from "../src/compilation-cache/cell-cache.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import { interceptTransaction } from "./support/intercept-transaction.ts";

const signer = await Identity.fromPassphrase("replication sibling race test");
const spaceA = signer.did() as MemorySpace; // where the compile lands
const spaceB = (await Identity.fromPassphrase(
  "replication sibling race parent space",
)).did() as MemorySpace; // the parent space, supplied by the sibling
const spaceC = (await Identity.fromPassphrase(
  "replication sibling race child space",
)).did() as MemorySpace; // the child space
const spaceD = (await Identity.fromPassphrase(
  "replication sibling race empty origin",
)).did() as MemorySpace; // an origin nothing ever supplies
const spaceE = (await Identity.fromPassphrase(
  "replication sibling race fallback target",
)).did() as MemorySpace; // the fallback-supplied target
const spaceF = (await Identity.fromPassphrase(
  "replication sibling race dead target",
)).did() as MemorySpace;
const spaceG = (await Identity.fromPassphrase(
  "replication sibling race in-flight compile target",
)).did() as MemorySpace; // where the GATED supplier compile persists
const spaceH = (await Identity.fromPassphrase(
  "replication sibling race second fallback candidate",
)).did() as MemorySpace; // the candidate AFTER the throwing one

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    {
      name: "/main.tsx",
      contents: [
        "import { pattern } from 'commonfabric';",
        "export default pattern(() => ({ label: 'replicated child' }));",
      ].join("\n"),
    },
  ],
};

// A LIBRARY module and an importer: compiled together, the persist's ENTRY
// is the importer while the lib's pattern carries the LIB module's own
// content identity — the index-served shape, where the replicated entry is
// a MODULE of the closure some other space's persist wrote.
const LIB_SOURCE = [
  "import { pattern } from 'commonfabric';",
  "export const libPattern = pattern(() => ({ label: 'library child' }));",
].join("\n");
const PROGRAM_WITH_LIB: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    {
      name: "/main.tsx",
      contents: [
        "import { pattern } from 'commonfabric';",
        "import { libPattern } from './lib.tsx';",
        "export default pattern(() => ({ label: 'importer', libPattern }));",
      ].join("\n"),
    },
    { name: "/lib.tsx", contents: LIB_SOURCE },
  ],
};

// The park registry's FIFO cap — MAX_PARKED_FAILED_REPLICATIONS in
// pattern-manager.ts, counted in distinct WANTED identities. Hard-coded on
// purpose: moving the cap has to be a deliberate change that re-reads the
// eviction pin below, not a silent one.
const PARK_CAP = 64;
const EVICTION_LIB_COUNT = PARK_CAP + 1;
const EVICTION_LIB_INDICES = Array.from(
  { length: EVICTION_LIB_COUNT },
  (_unused, index) => index,
);

// One program whose main imports EVICTION_LIB_COUNT standalone lib modules.
// A single compile mints that many distinct content identities, each its own
// closure root (the libs import nothing but the fabric), so the eviction pin
// can park one replication per WANTED identity without paying for a compile
// each time. Every lib is REFERENCED in main's result so none is shaken out.
const EVICTION_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    {
      name: "/main.tsx",
      contents: [
        "import { pattern } from 'commonfabric';",
        ...EVICTION_LIB_INDICES.map((index) =>
          `import { lib${index} } from './lib${index}.tsx';`
        ),
        "export default pattern(() => ({",
        "  label: 'eviction importer',",
        ...EVICTION_LIB_INDICES.map((index) => `  lib${index},`),
        "}));",
      ].join("\n"),
    },
    ...EVICTION_LIB_INDICES.map((index) => ({
      name: `/lib${index}.tsx`,
      contents: [
        "import { pattern } from 'commonfabric';",
        `export const lib${index} = pattern(() => ({`,
        `  label: 'eviction lib ${index}',`,
        "}));",
      ].join("\n"),
    })),
  ],
};

describe("closure replication: the in-flight sibling supplier race", () => {
  let server: MemoryV2Server.Server;
  let storageManager: EmulatedStorageManager;
  let runtime: Runtime;

  beforeEach(async () => {
    server = newSharedServer();
    storageManager = EmulatedStorageManager.connectTo(server, { as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      experimental: { serverExecution: true },
    });
    // World-writable genesis for the replication targets: the write-backs
    // into them are ordinary client-shaped commits by `signer`.
    for (const space of [spaceB, spaceC, spaceE, spaceF, spaceG, spaceH]) {
      Engine.applyCommit(await server.engineForSpace(space), {
        sessionId: "test-genesis-session",
        space,
        principal: space,
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: `of:${space}`,
            value: { value: { "did:key:alice": "OWNER", "*": "WRITE" } },
          }],
        },
      });
    }
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
    await server.close();
  });

  /** Run `body` with the `pattern-manager` logger's error lines captured,
   * resolved exactly as the logger resolves them (its messages are lazy
   * closures). The logger is a process-wide singleton, so the spy is an own
   * property shadowing the prototype method, deleted again afterwards, and
   * it delegates so the line still prints. */
  const captureManagerErrors = async (
    body: () => Promise<void>,
  ): Promise<{ key: string; line: string }[]> => {
    const managerLogger = getLogger("pattern-manager");
    const realError = managerLogger.error.bind(managerLogger);
    const captured: { key: string; line: string }[] = [];
    const spied = managerLogger as unknown as {
      error?: (key: string, ...messages: LogMessage[]) => void;
    };
    spied.error = (key: string, ...messages: LogMessage[]) => {
      const parts = messages.flatMap((message) => {
        const resolved = typeof message === "function"
          ? (message as () => unknown)()
          : message;
        return Array.isArray(resolved) ? resolved : [resolved];
      });
      captured.push({ key, line: parts.map(String).join(" ") });
      realError(key, ...messages);
    };
    try {
      await body();
    } finally {
      delete spied.error;
    }
    return captured;
  };

  /** Capture the `pattern-manager` logger's WARN and ERROR lines, resolved
   * exactly as the logger resolves them (lazy closures), invoking `onLine`
   * synchronously per line — the in-flight-supplier step below uses that to
   * release its compile gate the moment the replication's dry consult
   * announces itself. Same own-property-spy-over-the-singleton shape as
   * `captureManagerErrors` (which stays untouched: the existing steps pin
   * against it byte-identically); both spies delegate so the lines still
   * print. */
  const captureManagerLines = async (
    body: () => Promise<void>,
    onLine?: (
      entry: { level: "warn" | "error"; key: string; line: string },
    ) => void,
  ): Promise<{ level: "warn" | "error"; key: string; line: string }[]> => {
    const managerLogger = getLogger("pattern-manager");
    const captured: { level: "warn" | "error"; key: string; line: string }[] =
      [];
    const spied = managerLogger as unknown as {
      warn?: (key: string, ...messages: LogMessage[]) => void;
      error?: (key: string, ...messages: LogMessage[]) => void;
    };
    const resolveLine = (messages: LogMessage[]): string =>
      messages.flatMap((message) => {
        const resolved = typeof message === "function"
          ? (message as () => unknown)()
          : message;
        return Array.isArray(resolved) ? resolved : [resolved];
      }).map(String).join(" ");
    for (const level of ["warn", "error"] as const) {
      const real = managerLogger[level].bind(managerLogger);
      spied[level] = (key: string, ...messages: LogMessage[]) => {
        const entry = { level, key, line: resolveLine(messages) };
        captured.push(entry);
        onLine?.(entry);
        real(key, ...messages);
      };
    }
    try {
      await body();
    } finally {
      delete spied.warn;
      delete spied.error;
    }
    return captured;
  };

  /** The closure identities readable for `entry` in `space` on a fresh
   * transaction (the replication's own read shape). */
  const readableClosure = async (
    rt: Runtime,
    space: MemorySpace,
    entryIdentity: string,
  ): Promise<{ source: string[]; compiled: string[] }> => {
    const runtimeVersion = await getCompileCacheRuntimeVersion();
    const readTx = rt.edit();
    try {
      const source = await loadVerifiedSourceClosure(
        rt,
        space,
        entryIdentity,
        readTx,
      );
      const compiled = runtimeVersion === undefined
        ? new Map<string, unknown>()
        : await loadCompiledClosure(
          rt,
          space,
          entryIdentity,
          { runtimeVersion },
          readTx,
        );
      return {
        source: [...(source?.keys() ?? [])],
        compiled: [...compiled.keys()],
      };
    } finally {
      readTx.abort?.("replication race pin read");
    }
  };

  it(
    "materializes the child space for a child replication issued while " +
      "the sibling supplying its origin is still in flight (A -> B in " +
      "flight, B -> C waits for it instead of one-shot-dying)",
    async () => {
      // The compile's closure lands in A (E4-awaited).
      const pattern = await runtime.patternManager.compileOrGetPattern(
        PROGRAM,
        spaceA,
      );
      const entry = runtime.patternManager.getArtifactEntryRef(pattern);
      if (entry === undefined) throw new Error("compile produced no entry ref");
      await runtime.patternManager.flushCompileCacheWrites();
      await storageManager.synced();

      // BOTH replications run from a SECOND manager sharing the storage —
      // the artifact entry ref rides a module-level side table, so it holds
      // the same pattern object while having persisted NOTHING itself, i.e.
      // its FALLBACK-ORIGIN map is empty. That is the point: the compiling
      // manager recorded A as a persist target for this entry, so on THIS
      // manager the fallback would rescue the child replication from A even
      // with the sibling await deleted, and the mutation that removes the
      // await alone would leave this step green. Here the only thing that
      // can supply C is the await on the in-flight sibling — so the await is
      // load-bearing on its own and a refactor that drops it reds this step.
      const supplier = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        experimental: { serverExecution: true },
      });
      try {
        const errors = await captureManagerErrors(async () => {
          // The SIBLING: supply the parent space B from A — fire-and-forget,
          // in flight (the content-cache hit's shape).
          supplier.patternManager.replicatePatternToSpace(
            pattern,
            spaceB,
            spaceA,
          );
          // The CHILD replication, issued synchronously after, inside the same
          // handler run. Its origin is B, whose supplier is still mid-read:
          // without the sibling await, its one read of B finds nothing and
          // the replication dies; C never becomes loadable — the
          // `pattern-unloadable` forever-park.
          supplier.patternManager.replicatePatternToSpace(
            pattern,
            spaceC,
            spaceB,
          );

          await supplier.patternManager.flushCompileCacheWrites();
        });
        await storageManager.synced();

        // The sibling-await's contract is FIRST-TRY determinism: the
        // child replication never fails at all. This line assertion —
        // not the end-state below — is what keeps the ticket-await
        // mutation kill alive alongside the park/re-issue heal: with the
        // await deleted, the child's one-shot death is later HEALED by
        // the sibling's own persist record (the park/re-issue machinery
        // working as designed), so the end-state assertions go green —
        // but the failure line has fired, and first-try determinism is
        // exactly what this step pins.
        expect(
          errors.filter((error) => error.key === "closure-replication-failed")
            .length,
        ).toBe(0);

        // THE PIN: the child space holds the closure and a fresh runtime
        // loads the pattern from it by identity — exactly what the child
        // space's structure load needs to unpark.
        const childState = await readableClosure(
          runtime,
          spaceC,
          entry.identity,
        );
        expect(childState.source).toContain(entry.identity);
        const rt2 = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager,
          experimental: { serverExecution: true },
        });
        try {
          const loaded = await rt2.patternManager.loadPatternByIdentity(
            entry.identity,
            entry.symbol,
            spaceC,
          );
          expect(loaded).toBeDefined();
        } finally {
          await rt2.dispose();
        }
      } finally {
        await supplier.dispose();
      }
    },
  );

  it(
    "falls back from a DRY heuristic origin to a recorded persist target: " +
      "the parent space never received the closure (the in-memory index " +
      "served the pattern with no per-space persist), and the child space " +
      "still materializes from a space the manager durably persisted into",
    async () => {
      // The compile persists the closure into A — the manager records A as
      // a durable persist target for this entry.
      const pattern = await runtime.patternManager.compileOrGetPattern(
        PROGRAM,
        spaceA,
      );
      const entry = runtime.patternManager.getArtifactEntryRef(pattern);
      if (entry === undefined) throw new Error("compile produced no entry ref");
      await runtime.patternManager.flushCompileCacheWrites();

      // Origin D is DRY: nothing ever persisted into it and nothing is in
      // flight toward it (the parent ran the pattern from the in-memory
      // index; its space holds no closure). Without the fallback, the
      // one-shot read of D dies and E parks pattern-unloadable forever.
      runtime.patternManager.replicatePatternToSpace(pattern, spaceE, spaceD);
      await runtime.patternManager.flushCompileCacheWrites();
      await storageManager.synced();

      // THE PIN: E holds the closure — copied from the recorded target A,
      // byte-identical under content addressing, integrity-gated on read.
      const target = await readableClosure(runtime, spaceE, entry.identity);
      expect(target.source).toContain(entry.identity);
      const rt2 = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        experimental: { serverExecution: true },
      });
      try {
        const loaded = await rt2.patternManager.loadPatternByIdentity(
          entry.identity,
          entry.symbol,
          spaceE,
        );
        expect(loaded).toBeDefined();
      } finally {
        await rt2.dispose();
      }
    },
  );

  it(
    "keys the fallback by MODULE identity, not just the persist entry: " +
      "a pattern served from the in-memory index carries its own module's " +
      "identity while the space was supplied by its IMPORTER's persist",
    async () => {
      // The main runtime compiles the IMPORTER program into A: the
      // persist's entry is the importer, and the lib rides the closure as
      // a module (one addressable doc per module).
      const importer = await runtime.patternManager.compileOrGetPattern(
        PROGRAM_WITH_LIB,
        spaceA,
      );
      const importerEntry = runtime.patternManager.getArtifactEntryRef(
        importer,
      );
      if (importerEntry === undefined) throw new Error("no importer entry");
      await runtime.patternManager.flushCompileCacheWrites();
      await storageManager.synced();

      // Learn the lib MODULE's content identity from the persisted closure
      // itself (the module doc whose filename is /lib.tsx).
      let libIdentity: string | undefined;
      {
        const readTx = runtime.edit();
        try {
          const closure = await loadVerifiedSourceClosure(
            runtime,
            spaceA,
            importerEntry.identity,
            readTx,
          );
          for (const [identity, doc] of closure ?? []) {
            if (doc.filename === "/lib.tsx") libIdentity = identity;
          }
        } finally {
          readTx.abort?.("lib identity lookup");
        }
      }
      if (libIdentity === undefined) throw new Error("no lib identity");
      expect(libIdentity).not.toBe(importerEntry.identity);

      // The lib pattern is served from the in-memory artifact index by its
      // own module identity — no per-space persist happens on this path, so
      // the named space (dry D) stays dry.
      const libPattern = await runtime.patternManager.loadPatternByIdentity(
        libIdentity,
        "libPattern",
        spaceD,
      );
      expect(libPattern).toBeDefined();

      // The child replication for the index-served pattern, origin dry:
      // its entry is the LIB module's identity. With entry-only keying the
      // fallback map has no row for it and the replication one-shot-dies;
      // with module keying it copies from A.
      runtime.patternManager.replicatePatternToSpace(
        libPattern as never,
        spaceC,
        spaceD,
      );
      await runtime.patternManager.flushCompileCacheWrites();
      await storageManager.synced();
      const target = await readableClosure(runtime, spaceC, libIdentity);
      expect(target.source).toContain(libIdentity);
    },
  );

  it(
    "an entry with NO recorded persist anywhere still fails loud and " +
      "settles — neither the sibling await nor the fallback may turn " +
      "genuine absence into a hang or a fabricated copy",
    async () => {
      const pattern = await runtime.patternManager.compileOrGetPattern(
        PROGRAM,
        spaceA,
      );
      const entry = runtime.patternManager.getArtifactEntryRef(pattern);
      if (entry === undefined) throw new Error("compile produced no entry ref");
      await runtime.patternManager.flushCompileCacheWrites();

      // A SECOND manager holds the same pattern object (the artifact entry
      // ref rides a module-level side table) but has persisted NOTHING —
      // no fallback targets exist for it, and origin D is dry.
      const rt2 = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        experimental: { serverExecution: true },
      });
      try {
        const lines = await captureManagerLines(async () => {
          rt2.patternManager.replicatePatternToSpace(pattern, spaceF, spaceD);
          // The loud one-shot failure contract stands: the replication
          // settles (a hang here would wedge every flushCompileCacheWrites
          // caller — the client durability barrier's territory) and the
          // target stays empty.
          await rt2.patternManager.flushCompileCacheWrites();
          // A second flush would await anything the failure's own
          // registration re-issued — there must be nothing (asserted on
          // the lines below), and the no-storm contract is exactly that
          // genuine absence never self-clocks.
          await rt2.patternManager.flushCompileCacheWrites();
          await storageManager.synced();
        });
        const deadTarget = await readableClosure(rt2, spaceF, entry.identity);
        expect(deadTarget.source).toEqual([]);
        expect(deadTarget.compiled).toEqual([]);

        // LOUD is half the contract, and the half a settle-and-empty
        // assertion cannot see: turning the failing throw into a silent
        // return also leaves the target empty. `closure-replication-failed`
        // is the discriminating event a log forensics pass classifies by —
        // losing it blinds that pass with no lane going red. Exactly one
        // line, because the replication is one-shot: no retry loop may hide
        // behind the same log key.
        const failures = lines.filter((line) =>
          line.key === "closure-replication-failed"
        );
        expect(failures.length).toBe(1);
        expect(failures[0].line).toContain(`entry=${entry.identity}`);
        expect(failures[0].line).toContain(`from=${spaceD}`);
        expect(failures[0].line).toContain(`to=${spaceF}`);
        // The reason string is part of the contract: log forensics match
        // on it verbatim.
        expect(failures[0].line).toContain(
          "source closure unavailable in origin space",
        );

        // THE NO-STORM CONTROL for the park: genuine absence parks LOUDLY (the
        // park line is the wedge trace gaining an ending, never losing its
        // beginning) and then does NOTHING — no re-issue, no heal, no second
        // failure line, ever. The park is woken only by a matching persist
        // record, and this manager never records one; a mutation that lets the
        // park self-clock (retry without a record event) fires extra lines
        // here.
        const parked = lines.filter((line) =>
          line.key === "closure-replication-parked"
        );
        expect(parked.length).toBe(1);
        expect(parked[0].line).toContain(`entry=${entry.identity}`);
        expect(parked[0].line).toContain(`wanted=${entry.identity}`);
        expect(parked[0].line).toContain(`from=${spaceD}`);
        expect(parked[0].line).toContain(`to=${spaceF}`);
        expect(
          lines.filter((line) => line.key === "closure-replication-reissued")
            .length,
        ).toBe(0);
        expect(
          lines.filter((line) => line.key === "closure-replication-healed")
            .length,
        ).toBe(0);
      } finally {
        await rt2.dispose();
      }
    },
  );

  it(
    "awaits the in-flight compile registries once and re-consults when " +
      "the supplier compile is still MID-FLIGHT at consult time: no " +
      "persist has completed anywhere and the module-keyed fallback map " +
      "is CORRECTLY dry, so the replication awaits instead of " +
      "one-shot-dying",
    async () => {
      // R1's compile supplies only the pattern OBJECT (the entry ref rides
      // the module-level side table). Everything else runs on a SECOND
      // manager whose fallback map is empty and whose origin has no
      // replications into it, ever: neither a pre-populated map nor an
      // older-sibling await may be able to rescue the child, so the
      // once-await is load-bearing alone and a refactor that drops it reds
      // this step.
      const pattern = await runtime.patternManager.compileOrGetPattern(
        PROGRAM,
        spaceA,
      );
      const entry = runtime.patternManager.getArtifactEntryRef(pattern);
      if (entry === undefined) throw new Error("compile produced no entry ref");
      await runtime.patternManager.flushCompileCacheWrites();
      await storageManager.synced();

      const rt2 = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        experimental: { serverExecution: true },
      });
      const harnessSpy = rt2.harness as unknown as {
        compileToRecordGraph?: (...args: unknown[]) => Promise<unknown>;
      };
      try {
        // GATE rt2's compile pipeline: the first compileToRecordGraph call
        // signals that it started, then parks until released. The supplier
        // compile is then provably IN FLIGHT (it registered in
        // `inProgressCompilations` synchronously at `compileOrGetPattern`)
        // and provably PRE-PERSIST (its E4 persist sits far behind the
        // gate) — this geometry's timeline: compile waves running, zero
        // persists anywhere, the fallback map genuinely empty. No sleeps
        // anywhere — the gate releases on the replication's own announcement
        // (below), and the allSettled-then-re-consult is what makes the
        // record visible before the re-read, deterministically.
        const compileStarted = Promise.withResolvers<void>();
        const compileReleased = Promise.withResolvers<void>();
        const realCompile = harnessSpy.compileToRecordGraph;
        if (realCompile === undefined) throw new Error("no harness compile");
        const boundCompile = realCompile.bind(rt2.harness);
        let gated = true;
        harnessSpy.compileToRecordGraph = async (...args: unknown[]) => {
          if (gated) {
            gated = false;
            compileStarted.resolve();
            await compileReleased.promise;
          }
          return await boundCompile(...args);
        };

        // The gated supplier compile of the SAME program — content
        // addressing gives it the same entry identity — into fresh G. G
        // must be a space with no durable closure yet: a warm hit skips
        // the persist entirely and records nothing.
        const gatedCompile = rt2.patternManager.compileOrGetPattern(
          PROGRAM,
          spaceG,
        );
        // Loud construction guard instead of a silent hang: if the compile
        // settles without ever reaching the gate, fail the step. (The
        // loser's derived promise resolves — never rejects — so no
        // unhandled rejection when it settles after losing the race.)
        const gateEngaged = await Promise.race([
          compileStarted.promise.then(() => true),
          gatedCompile.then(() => false, () => false),
        ]);
        if (!gateEngaged) {
          throw new Error("supplier compile settled before the gate engaged");
        }

        const lines = await captureManagerLines(
          async () => {
            // The child replication from a forever-dry origin, issued while
            // the supplier compile is mid-flight. Without the in-flight await,
            // its consult finds origin AND map dry and it one-shot-dies; C
            // parks pattern-unloadable forever.
            rt2.patternManager.replicatePatternToSpace(
              pattern,
              spaceC,
              spaceD,
            );
            await rt2.patternManager.flushCompileCacheWrites();
            await storageManager.synced();
          },
          (entry) => {
            // Release the gate the moment the dry consult announces itself:
            // via the once-await's own warn (the compile then completes,
            // records G into the fallback map, and the re-consult finds
            // it), or — with the await neutralized — via the one-shot
            // failure line, so the step finishes fast and red instead of
            // hanging on the gate.
            if (
              entry.key === "closure-replication-await-inflight" ||
              entry.key === "closure-replication-failed"
            ) {
              compileReleased.resolve();
            }
          },
        );
        await gatedCompile;
        await rt2.patternManager.flushCompileCacheWrites();
        await storageManager.synced();

        // THE PIN: C materialized from the space the in-flight supplier
        // compile persisted into, discovered by the post-await re-consult —
        // and a fresh runtime loads the pattern from C by identity, which
        // is what unparks the demanded roots.
        const target = await readableClosure(rt2, spaceC, entry.identity);
        expect(target.source).toContain(entry.identity);
        const rt3 = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager,
          experimental: { serverExecution: true },
        });
        try {
          const loaded = await rt3.patternManager.loadPatternByIdentity(
            entry.identity,
            entry.symbol,
            spaceC,
          );
          expect(loaded).toBeDefined();
        } finally {
          await rt3.dispose();
        }

        // The once-await announced itself exactly once, with the in-flight
        // census that discriminates this geometry from the not-yet-started
        // supplier (a red with `compilations=0 byIdentityLoads=0` on this
        // line means the supplier compile had not STARTED by consult time).
        const awaited = lines.filter((line) =>
          line.key === "closure-replication-await-inflight"
        );
        expect(awaited.length).toBe(1);
        expect(awaited[0].line).toContain(`entry=${entry.identity}`);
        expect(awaited[0].line).toContain(`from=${spaceD}`);
        expect(awaited[0].line).toContain(`to=${spaceC}`);
        expect(awaited[0].line).toContain("compilations=1");
        expect(awaited[0].line).toContain("byIdentityLoads=0");
        // And the one-shot failure line never fired: the await turned the
        // former one-shot death into a completed replication.
        expect(
          lines.filter((line) => line.key === "closure-replication-failed")
            .length,
        ).toBe(0);
      } finally {
        delete harnessSpy.compileToRecordGraph;
        await rt2.dispose();
      }
    },
  );

  it(
    "skips a THROWING fallback read loudly, never loop-aborting: the " +
      "next recorded candidate still rescues the child, so a store-level " +
      "error on one candidate does not cost the replication its " +
      "remaining byte-identical copies",
    async () => {
      // R1's compile supplies the pattern OBJECT; rt2 is the manager
      // under test with its own fallback map.
      const pattern = await runtime.patternManager.compileOrGetPattern(
        PROGRAM,
        spaceA,
      );
      const entry = runtime.patternManager.getArtifactEntryRef(pattern);
      if (entry === undefined) throw new Error("compile produced no entry ref");
      await runtime.patternManager.flushCompileCacheWrites();
      await storageManager.synced();

      const rt2 = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        experimental: { serverExecution: true },
      });
      const editSpy = rt2 as unknown as {
        edit?: () => ReturnType<Runtime["edit"]>;
      };
      try {
        // Record TWO fallback candidates in rt2's map, in insertion
        // order G then H: the compile persists into G; the content-cache
        // hit for the same program then fires the sibling replication
        // G -> H, whose persist records H.
        await rt2.patternManager.compileOrGetPattern(PROGRAM, spaceG);
        await rt2.patternManager.flushCompileCacheWrites();
        await rt2.patternManager.compileOrGetPattern(PROGRAM, spaceH);
        await rt2.patternManager.flushCompileCacheWrites();
        await storageManager.synced();

        // ARM: every transaction read that addresses G now throws a
        // store-level error (the real shape of a flaky/broken store —
        // NOT a clean miss). D and H reads pass through untouched, so
        // the injection is order-independent: it fires exactly when the
        // fallback loop reads G.
        const realEdit = rt2.edit.bind(rt2);
        let armed = true;
        editSpy.edit = () => {
          const tx = realEdit();
          if (!armed) return tx;
          return interceptTransaction(tx, (_method, args, proceed) => {
            let mentionsG = false;
            try {
              mentionsG = JSON.stringify(args)?.includes(spaceG) ?? false;
            } catch {
              // Unstringifiable args cannot address a space by DID.
            }
            if (armed && mentionsG) {
              throw new Error(
                "injected store failure for the armed fallback space",
              );
            }
            return proceed();
          });
        };

        const lines = await captureManagerLines(
          async () => {
            // Origin D is dry; the map holds {G, H}; G's read THROWS.
            // With a bare `await readOrigin(fallback)`, the store error
            // would abort the whole loop and the child one-shot-die with H
            // untried; the loop instead logs and continues to H.
            rt2.patternManager.replicatePatternToSpace(
              pattern,
              spaceC,
              spaceD,
            );
            await rt2.patternManager.flushCompileCacheWrites();
            await storageManager.synced();
          },
          (entry) => {
            // Disarm once the injected failure has been observed: the
            // loop has moved past G, and the rescue's own writes must
            // hit the real store unimpeded.
            if (entry.key === "closure-replication-fallback-read-failed") {
              armed = false;
            }
          },
        );

        // THE PIN: H rescued the child — the throwing candidate cost
        // one warn, not the replication.
        const target = await readableClosure(rt2, spaceC, entry.identity);
        expect(target.source).toContain(entry.identity);
        const failed = lines.filter((line) =>
          line.key === "closure-replication-fallback-read-failed"
        );
        expect(failed.length).toBe(1);
        expect(failed[0].line).toContain(`fallback=${spaceG}`);
        expect(failed[0].line).toContain(
          "injected store failure for the armed fallback space",
        );
        const rescued = lines.filter((line) =>
          line.key === "closure-replication-fallback-origin"
        );
        expect(rescued.length).toBe(1);
        expect(rescued[0].line).toContain(`fallback=${spaceH}`);
        expect(
          lines.filter((line) => line.key === "closure-replication-failed")
            .length,
        ).toBe(0);
      } finally {
        delete editSpy.edit;
        await rt2.dispose();
      }
    },
  );

  it(
    "PARKS a failed replication and RE-ISSUES it on a later matching " +
      "persist record: the supplier compile had not STARTED at consult " +
      "time, so no await can see it, and the supply's own record event " +
      "heals the failure, with the loud one-shot line unchanged",
    async () => {
      // R1's compile supplies only the pattern OBJECT (the entry ref
      // rides the module-level side table). rt2 — the manager under test
      // — has persisted NOTHING: dry fallback map, no in-flight compiles,
      // origin D never supplied. That is the park's defining state: every
      // rescue the once-await family owns is structurally absent, and
      // without the park the replication one-shot-dies with the child
      // space empty forever.
      const pattern = await runtime.patternManager.compileOrGetPattern(
        PROGRAM,
        spaceA,
      );
      const entry = runtime.patternManager.getArtifactEntryRef(pattern);
      if (entry === undefined) throw new Error("compile produced no entry ref");
      await runtime.patternManager.flushCompileCacheWrites();
      await storageManager.synced();

      const rt2 = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        experimental: { serverExecution: true },
      });
      try {
        const lines = await captureManagerLines(async () => {
          // The child replication from the forever-dry origin: fails
          // loudly (the byte-identical one-shot line) and PARKS under
          // the wanted identity.
          rt2.patternManager.replicatePatternToSpace(pattern, spaceC, spaceD);
          await rt2.patternManager.flushCompileCacheWrites();

          // THE SUPPLIER ARRIVES — after the failure:
          // rt2's own compile of the same program persists into G and
          // records every module identity. The record is the wake: the
          // parked replication re-issues (fresh ticket, full
          // registration), its fallback read finds G, and the child
          // materializes. Event-driven — no timers anywhere in test or
          // product.
          await rt2.patternManager.compileOrGetPattern(PROGRAM, spaceG);
          // Two flushes: the re-issue registers in `compileCacheWrites`
          // from a microtask the record queued, so the first flush's
          // snapshot may predate it; the second flush's snapshot cannot.
          await rt2.patternManager.flushCompileCacheWrites();
          await rt2.patternManager.flushCompileCacheWrites();
          await storageManager.synced();
        });

        // THE PIN: the child space healed — closure present, loadable by
        // a fresh runtime, which is what unparks the demanded roots.
        const target = await readableClosure(rt2, spaceC, entry.identity);
        expect(target.source).toContain(entry.identity);
        const rt3 = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager,
          experimental: { serverExecution: true },
        });
        try {
          const loaded = await rt3.patternManager.loadPatternByIdentity(
            entry.identity,
            entry.symbol,
            spaceC,
          );
          expect(loaded).toBeDefined();
        } finally {
          await rt3.dispose();
        }

        // The wedge trace gained an ending without losing its beginning:
        // exactly one loud failure (the pre-heal contract, byte-identical
        // reason), one park, one record-triggered re-issue, one heal.
        const failures = lines.filter((line) =>
          line.key === "closure-replication-failed"
        );
        expect(failures.length).toBe(1);
        expect(failures[0].line).toContain(
          "source closure unavailable in origin space",
        );
        const parked = lines.filter((line) =>
          line.key === "closure-replication-parked"
        );
        expect(parked.length).toBe(1);
        expect(parked[0].line).toContain(`wanted=${entry.identity}`);
        const reissued = lines.filter((line) =>
          line.key === "closure-replication-reissued"
        );
        expect(reissued.length).toBe(1);
        expect(reissued[0].line).toContain(`trigger=persist-record:${spaceG}`);
        const healed = lines.filter((line) =>
          line.key === "closure-replication-healed"
        );
        expect(healed.length).toBe(1);
        expect(healed[0].line).toContain(`entry=${entry.identity}`);
        expect(healed[0].line).toContain(`to=${spaceC}`);
        // The park's discriminator stands: the registries were EMPTY at the
        // failing consult (no await-inflight announcement) — the heal is
        // the record event's doing, not a hidden once-await rescue.
        expect(
          lines.filter((line) =>
            line.key === "closure-replication-await-inflight"
          ).length,
        ).toBe(0);
      } finally {
        await rt2.dispose();
      }
    },
  );

  it(
    "the park keys by the WANTED identity and the wake matches EVERY " +
      "recorded module identity — a replication of an index-served " +
      "MODULE pattern is healed by its IMPORTER's persist (whose entry " +
      "is the importer, not the module: an entry-matched wake would " +
      "sleep through exactly this record)",
    async () => {
      // R1 compiles the importer program into A (durable); rt2 warm-loads the
      // LIB pattern by its own module identity from A — the load path persists
      // NOTHING and records NOTHING (the index-served supplier hole), so rt2's
      // map stays dry while its in-memory index can serve the lib pattern
      // object.
      const importer = await runtime.patternManager.compileOrGetPattern(
        PROGRAM_WITH_LIB,
        spaceA,
      );
      const importerEntry = runtime.patternManager.getArtifactEntryRef(
        importer,
      );
      if (importerEntry === undefined) throw new Error("no importer entry");
      await runtime.patternManager.flushCompileCacheWrites();
      await storageManager.synced();

      let libIdentity: string | undefined;
      {
        const readTx = runtime.edit();
        try {
          const closure = await loadVerifiedSourceClosure(
            runtime,
            spaceA,
            importerEntry.identity,
            readTx,
          );
          for (const [identity, doc] of closure ?? []) {
            if (doc.filename === "/lib.tsx") libIdentity = identity;
          }
        } finally {
          readTx.abort?.("lib identity lookup");
        }
      }
      if (libIdentity === undefined) throw new Error("no lib identity");
      expect(libIdentity).not.toBe(importerEntry.identity);

      const rt2 = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        experimental: { serverExecution: true },
      });
      try {
        const libPattern = await rt2.patternManager.loadPatternByIdentity(
          libIdentity,
          "libPattern",
          spaceA,
        );
        expect(libPattern).toBeDefined();

        const lines = await captureManagerLines(async () => {
          // The lib replication from dry D on the dry-mapped rt2: fails
          // and parks under the LIB module's identity (the wanted one).
          rt2.patternManager.replicatePatternToSpace(
            libPattern as never,
            spaceC,
            spaceD,
          );
          await rt2.patternManager.flushCompileCacheWrites();

          // The supplier: rt2 compiles the IMPORTER into G. The persist's
          // ENTRY is the importer; the lib rides it as a MODULE — and the
          // record registers EVERY module identity, so the lib park
          // wakes. A wake matched on the persist call's entry alone would
          // sleep through this record and the child would stay empty.
          await rt2.patternManager.compileOrGetPattern(
            PROGRAM_WITH_LIB,
            spaceG,
          );
          await rt2.patternManager.flushCompileCacheWrites();
          await rt2.patternManager.flushCompileCacheWrites();
          await storageManager.synced();
        });

        // THE PIN: the lib closure materialized in C.
        const target = await readableClosure(rt2, spaceC, libIdentity);
        expect(target.source).toContain(libIdentity);
        const parked = lines.filter((line) =>
          line.key === "closure-replication-parked"
        );
        expect(parked.length).toBe(1);
        expect(parked[0].line).toContain(`wanted=${libIdentity}`);
        const healed = lines.filter((line) =>
          line.key === "closure-replication-healed"
        );
        expect(healed.length).toBe(1);
        expect(healed[0].line).toContain(`wanted=${libIdentity}`);
      } finally {
        await rt2.dispose();
      }
    },
  );

  it(
    "re-issues IMMEDIATELY instead of parking when a failure registers " +
      "while the map ALREADY holds a usable record: the supplier " +
      "completed inside the failing attempt's read window, its record " +
      "event has already passed and may never recur, so a park would " +
      "wait forever on yesterday's event",
    async () => {
      // rt2 both holds the pattern object and recorded a real persist:
      // its own compile into G. The failing attempt then cannot USE that
      // record — G's reads throw store-level for exactly one attempt (a
      // transient store failure, the F5-1 class) — so the failure
      // registers with the map already holding the answer. That is the
      // seam state interleaving (b) produces (record lands between the
      // read pass and the failure registration); the deterministic
      // constructor differs, the registration-time state is identical.
      // The registration-time map check must fire the immediate re-issue;
      // the WAKE alone can never rescue this step, because no further
      // record event ever happens — which is exactly what isolates this
      // pin from the wake pin two steps up.
      const pattern = await runtime.patternManager.compileOrGetPattern(
        PROGRAM,
        spaceA,
      );
      const entry = runtime.patternManager.getArtifactEntryRef(pattern);
      if (entry === undefined) throw new Error("compile produced no entry ref");
      await runtime.patternManager.flushCompileCacheWrites();
      await storageManager.synced();

      const rt2 = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        experimental: { serverExecution: true },
      });
      const editSpy = rt2 as unknown as {
        edit?: () => ReturnType<Runtime["edit"]>;
      };
      try {
        await rt2.patternManager.compileOrGetPattern(PROGRAM, spaceG);
        await rt2.patternManager.flushCompileCacheWrites();
        await storageManager.synced();

        // ARM (the step-6 shape): every tx read addressing G throws
        // store-level until the fallback loop's loud warn observes the
        // injection — then the store "recovers" and the immediate
        // re-issue's read of G goes through.
        const realEdit = rt2.edit.bind(rt2);
        let armed = true;
        editSpy.edit = () => {
          const tx = realEdit();
          if (!armed) return tx;
          return interceptTransaction(tx, (_method, args, proceed) => {
            let mentionsG = false;
            try {
              mentionsG = JSON.stringify(args)?.includes(spaceG) ?? false;
            } catch {
              // Unstringifiable args cannot address a space by DID.
            }
            if (armed && mentionsG) {
              throw new Error(
                "injected store failure for the armed fallback space",
              );
            }
            return proceed();
          });
        };

        const lines = await captureManagerLines(
          async () => {
            rt2.patternManager.replicatePatternToSpace(
              pattern,
              spaceC,
              spaceD,
            );
            await rt2.patternManager.flushCompileCacheWrites();
            // The immediate re-issue registers from the failure's own
            // catch during the first flush; the second flush awaits it.
            await rt2.patternManager.flushCompileCacheWrites();
            await storageManager.synced();
          },
          (entry) => {
            if (entry.key === "closure-replication-fallback-read-failed") {
              armed = false;
            }
          },
        );

        // THE PIN: healed by the registration-time check — no park, one
        // immediate re-issue, the child materialized.
        const target = await readableClosure(rt2, spaceC, entry.identity);
        expect(target.source).toContain(entry.identity);
        expect(
          lines.filter((line) => line.key === "closure-replication-parked")
            .length,
        ).toBe(0);
        const reissued = lines.filter((line) =>
          line.key === "closure-replication-reissued"
        );
        expect(reissued.length).toBe(1);
        expect(reissued[0].line).toContain("trigger=recorded-at-registration");
        const healed = lines.filter((line) =>
          line.key === "closure-replication-healed"
        );
        expect(healed.length).toBe(1);
        // Exactly one loud failure — the original; the healed re-issue
        // fails nowhere.
        expect(
          lines.filter((line) => line.key === "closure-replication-failed")
            .length,
        ).toBe(1);
      } finally {
        delete editSpy.edit;
        await rt2.dispose();
      }
    },
  );

  it(
    "a DEPENDENCY-frame failure parks under the DEPENDENCY's identity, " +
      "not the entry's — the dependency's own supplier heals it, and the " +
      "re-issue re-walks the FULL entry replication (fabric imports are " +
      "separate closure roots: an entry-keyed park would sleep through " +
      "the dependency supplier's record, whose persisted set never " +
      "contains the importer's entry). A persist failure, by contrast, " +
      "never parks — the park is for SUPPLY failures only",
    async () => {
      // LIB compiled into A. The comment marker exists only in the lib's
      // SOURCE text — never in the importer's docs and stripped from
      // compiled JS — so a write-injection keyed on it fails exactly the
      // lib's own source-doc writes and nothing else.
      const LIB_PROGRAM: RuntimeProgram = {
        main: "/dep-lib.tsx",
        files: [{
          name: "/dep-lib.tsx",
          contents: [
            "// LIB-SOURCE-MARKER-7C (write-injection key; source-only)",
            "import { pattern } from 'commonfabric';",
            "export const depLib = pattern(() => ({ label: 'dep lib' }));",
            "export default depLib;",
          ].join("\n"),
        }],
      };
      const lib = await runtime.patternManager.compileOrGetPattern(
        LIB_PROGRAM,
        spaceA,
      );
      const libEntry = runtime.patternManager.getArtifactEntryRef(lib);
      if (libEntry === undefined) throw new Error("no lib entry ref");
      await runtime.patternManager.flushCompileCacheWrites();
      await storageManager.synced();

      // The IMPORTER fabric-imports the lib pinned by identity with A as
      // the source space, compiled into B. Fabric dependencies are
      // separate closure roots: the importer's own walked closure
      // EXCLUDES the lib's docs, and a REPLICATION persists exactly the
      // walked closure — the lib root crosses spaces only through the
      // dependency recursion. (A compile-target space also receives the
      // mounted dep docs, which is why the partial origin below is built
      // by replication, the same mechanism that produces it in
      // production.)
      const IMPORTER_PROGRAM: RuntimeProgram = {
        main: "/dep-main.tsx",
        files: [{
          name: "/dep-main.tsx",
          contents: [
            "import { pattern } from 'commonfabric';",
            `import depLib from "cf:/${spaceA}/pattern:${libEntry.identity}";`,
            "export default pattern(() => ({ label: 'importer', depLib }));",
          ].join("\n"),
        }],
      };
      const importer = await runtime.patternManager.compileOrGetPattern(
        IMPORTER_PROGRAM,
        spaceB,
      );
      const importerEntry = runtime.patternManager.getArtifactEntryRef(
        importer,
      );
      if (importerEntry === undefined) throw new Error("no importer entry");
      await runtime.patternManager.flushCompileCacheWrites();
      await storageManager.synced();

      const rt2 = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        experimental: { serverExecution: true },
      });
      const editSpy = rt2 as unknown as {
        edit?: () => ReturnType<Runtime["edit"]>;
      };
      try {
        // PHASE 1 — build the PARTIAL ORIGIN through the real production
        // mechanism, a replication-tail persist failure: replicate the
        // importer B -> E with the lib's doc writes failing store-level
        // (own-property shadow on the tx writes — the marker only ever
        // appears in lib source text, and a replication's ENTRY persist
        // writes none of it). The source text reaches storage as the
        // lib's code document, staged through the single-value write,
        // while the record itself goes through the batched write, so
        // both entry points carry the shadow. The entry closure lands in
        // E; the dependency root does not. And the failure classification
        // pin: a PERSIST failure does NOT park — the park is for supply
        // failures only, where a future record event is the remedy.
        const realEdit = rt2.edit.bind(rt2);
        let armed = true;
        const mentionsMarker = (args: unknown[]): boolean => {
          try {
            return JSON.stringify(args)?.includes("LIB-SOURCE-MARKER-7C") ??
              false;
          } catch {
            // Unstringifiable args cannot carry the marker.
            return false;
          }
        };
        editSpy.edit = () => {
          const tx = realEdit();
          if (!armed) return tx;
          const spied = tx as unknown as Record<
            "writeValuesOrThrow" | "writeOrThrow",
            (...args: unknown[]) => unknown
          >;
          for (
            const method of ["writeValuesOrThrow", "writeOrThrow"] as const
          ) {
            const realWrite = spied[method].bind(tx);
            spied[method] = (...args: unknown[]) => {
              if (armed && mentionsMarker(args)) {
                throw new Error(
                  "injected store failure for the dependency root's writes",
                );
              }
              return realWrite(...args);
            };
          }
          return tx;
        };
        const phase1 = await captureManagerLines(async () => {
          rt2.patternManager.replicatePatternToSpace(
            importer,
            spaceE,
            spaceB,
          );
          await rt2.patternManager.flushCompileCacheWrites();
          await rt2.patternManager.flushCompileCacheWrites();
          await storageManager.synced();
        });
        armed = false;
        expect(
          phase1.filter((line) => line.key === "closure-replication-failed")
            .length,
        ).toBe(1);
        expect(
          phase1.filter((line) => line.key === "closure-replication-parked")
            .length,
        ).toBe(0);
        const importerInE = await readableClosure(
          rt2,
          spaceE,
          importerEntry.identity,
        );
        expect(importerInE.source).toContain(importerEntry.identity);
        const libInE = await readableClosure(rt2, spaceE, libEntry.identity);
        expect(libInE.source).toEqual([]);

        // PHASE 2 — the dependency-frame SUPPLY failure and its heal.
        // rt2's map holds the importer's identities (phase 1's entry
        // persist recorded E) but NOTHING for the lib (its persist
        // failed before recording): the E -> C replication's entry frame
        // succeeds, the dependency frame finds E dry for the lib and the
        // map dry — the park's WANTED identity is the LIB's while its
        // re-issue root stays the IMPORTER.
        const phase2 = await captureManagerLines(async () => {
          rt2.patternManager.replicatePatternToSpace(
            importer,
            spaceC,
            spaceE,
          );
          await rt2.patternManager.flushCompileCacheWrites();

          // The DEPENDENCY's supplier: rt2 compiles the LIB into G. Its
          // record set is the lib's own identities — the importer's
          // entry is NOT in it, which is exactly why an entry-keyed park
          // would never wake here.
          await rt2.patternManager.compileOrGetPattern(LIB_PROGRAM, spaceG);
          await rt2.patternManager.flushCompileCacheWrites();
          await rt2.patternManager.flushCompileCacheWrites();
          await storageManager.synced();
        });

        // THE PIN: the heal re-walked the full importer replication, so
        // C holds BOTH closure roots — the importer's AND the lib's.
        const importerInC = await readableClosure(
          rt2,
          spaceC,
          importerEntry.identity,
        );
        expect(importerInC.source).toContain(importerEntry.identity);
        const libInC = await readableClosure(rt2, spaceC, libEntry.identity);
        expect(libInC.source).toContain(libEntry.identity);

        // The park's discriminating shape: wanted = the DEPENDENCY,
        // entry = the IMPORTER — two different identities on one line.
        const parked = phase2.filter((line) =>
          line.key === "closure-replication-parked"
        );
        expect(parked.length).toBe(1);
        expect(parked[0].line).toContain(`wanted=${libEntry.identity}`);
        expect(parked[0].line).toContain(`entry=${importerEntry.identity}`);
        const healed = phase2.filter((line) =>
          line.key === "closure-replication-healed"
        );
        expect(healed.length).toBe(1);
        expect(healed[0].line).toContain(`wanted=${libEntry.identity}`);
        expect(healed[0].line).toContain(`entry=${importerEntry.identity}`);
      } finally {
        delete editSpy.edit;
        await rt2.dispose();
      }
    },
  );

  it(
    "a record into a park's OWN toSpace does NOT wake it — the self-heal " +
      "guard: a replication records only into its target, and the target " +
      "is the one space a re-issue's read structurally skips (the fallback " +
      "loop skips toSpace), so waking on it could only ever buy a doomed " +
      "loud re-issue. And the skip is a SKIP, not a consume: a record into " +
      "a THIRD space still wakes and heals the same park",
    async () => {
      const pattern = await runtime.patternManager.compileOrGetPattern(
        PROGRAM,
        spaceA,
      );
      const entry = runtime.patternManager.getArtifactEntryRef(pattern);
      if (entry === undefined) throw new Error("compile produced no entry ref");
      await runtime.patternManager.flushCompileCacheWrites();
      await storageManager.synced();

      const rt2 = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        experimental: { serverExecution: true },
      });
      try {
        // PHASE 1 — the park: a child replication from the forever-dry
        // origin D into C, on a manager whose fallback map is empty.
        const phase1 = await captureManagerLines(async () => {
          rt2.patternManager.replicatePatternToSpace(pattern, spaceC, spaceD);
          await rt2.patternManager.flushCompileCacheWrites();
        });
        const parked = phase1.filter((line) =>
          line.key === "closure-replication-parked"
        );
        expect(parked.length).toBe(1);
        expect(parked[0].line).toContain(`to=${spaceC}`);

        // PHASE 2 — a SECOND replication lands the same closure in the
        // park's OWN toSpace C, from the wet origin A. Its persist records
        // the parked WANTED identity into C — the exact shape a park's own
        // successful heal produces, and the one space
        // `readOriginWithFallbacks` can never read from (it skips both
        // `fromSpace` and `toSpace`). The wake must skip this record.
        const phase2 = await captureManagerLines(async () => {
          rt2.patternManager.replicatePatternToSpace(pattern, spaceC, spaceA);
          await rt2.patternManager.flushCompileCacheWrites();
          await rt2.patternManager.flushCompileCacheWrites();
          await storageManager.synced();
        });
        expect(
          phase2.filter((line) => line.key === "closure-replication-reissued")
            .length,
        ).toBe(0);
        expect(
          phase2.filter((line) => line.key === "closure-replication-healed")
            .length,
        ).toBe(0);
        expect(
          phase2.filter((line) => line.key === "closure-replication-failed")
            .length,
        ).toBe(0);
        // …and the quiet is not vacuous: that second replication really
        // landed its closure in C, so the persist — and therefore the
        // record the wake had to skip — really happened.
        const landedInC = await readableClosure(rt2, spaceC, entry.identity);
        expect(landedInC.source).toContain(entry.identity);

        // PHASE 3 — the park SURVIVED that skipped record (the guard
        // `continue`s before the delete): a record into a THIRD space is
        // usable supply, and it wakes and heals exactly this park.
        const phase3 = await captureManagerLines(async () => {
          await rt2.patternManager.compileOrGetPattern(PROGRAM, spaceG);
          await rt2.patternManager.flushCompileCacheWrites();
          await rt2.patternManager.flushCompileCacheWrites();
          await storageManager.synced();
        });
        const reissued = phase3.filter((line) =>
          line.key === "closure-replication-reissued"
        );
        expect(reissued.length).toBe(1);
        expect(reissued[0].line).toContain(`wanted=${entry.identity}`);
        expect(reissued[0].line).toContain(`trigger=persist-record:${spaceG}`);
        expect(
          phase3.filter((line) => line.key === "closure-replication-healed")
            .length,
        ).toBe(1);
        // The heal read G, not C: the fallback loop skipped the target it
        // was about to write (the same filter, one layer down).
        const fallbacks = phase3.filter((line) =>
          line.key === "closure-replication-fallback-origin"
        );
        expect(fallbacks.length).toBe(1);
        expect(fallbacks[0].line).toContain(`fallback=${spaceG}`);
        expect(fallbacks[0].line).toContain(`to=${spaceC}`);
      } finally {
        await rt2.dispose();
      }
    },
  );

  it(
    "caps the park registry FIFO: the 65th distinct WANTED identity " +
      "evicts the OLDEST loudly, and the evicted child drops back to the " +
      "loud one-shot wedge — a later record of ITS identity " +
      "wakes nothing, while a SURVIVING park's record still heals (so the " +
      "silence is the eviction, not a broken wake)",
    async () => {
      const importer = await runtime.patternManager.compileOrGetPattern(
        EVICTION_PROGRAM,
        spaceA,
      );
      const importerEntry = runtime.patternManager.getArtifactEntryRef(
        importer,
      );
      if (importerEntry === undefined) throw new Error("no importer entry");
      await runtime.patternManager.flushCompileCacheWrites();
      await storageManager.synced();

      // Each lib module's own content identity, indexed by its DECLARED
      // number — so the park order below is the loop's order and the FIFO
      // victim is a fact rather than whatever the closure map iterates.
      const libIdentities: string[] = new Array(EVICTION_LIB_COUNT);
      {
        const readTx = runtime.edit();
        try {
          const closure = await loadVerifiedSourceClosure(
            runtime,
            spaceA,
            importerEntry.identity,
            readTx,
          );
          for (const [identity, doc] of closure ?? []) {
            const match = /^\/lib(\d+)\.tsx$/.exec(doc.filename ?? "");
            if (match !== null) libIdentities[Number(match[1])] = identity;
          }
        } finally {
          readTx.abort?.("park eviction lib identity lookup");
        }
      }
      expect(new Set(libIdentities).size).toBe(EVICTION_LIB_COUNT);

      // The pattern objects come from the COMPILING manager's in-memory
      // artifact index — no storage read, no persist, the same index-served
      // shape the motivating flow hands the replication. rt2, the manager
      // under test, therefore still has an empty fallback map, so every
      // replication below is a genuine supply failure and parks.
      const libPatterns: unknown[] = [];
      for (const index of EVICTION_LIB_INDICES) {
        const loaded = await runtime.patternManager.loadPatternByIdentity(
          libIdentities[index],
          `lib${index}`,
          spaceA,
        );
        if (loaded === undefined) throw new Error(`no pattern for lib${index}`);
        libPatterns.push(loaded);
      }

      const rt2 = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        experimental: { serverExecution: true },
      });
      try {
        const lines = await captureManagerLines(async () => {
          // One park per identity, issued ONE AT A TIME: the registry's
          // insertion order is the failure-REGISTRATION order, so
          // serializing here is what makes "the oldest" deterministic.
          for (const libPattern of libPatterns) {
            rt2.patternManager.replicatePatternToSpace(
              libPattern as never,
              spaceC,
              spaceD,
            );
            await rt2.patternManager.flushCompileCacheWrites();
          }
        });

        expect(
          lines.filter((line) => line.key === "closure-replication-parked")
            .length,
        ).toBe(EVICTION_LIB_COUNT);
        // THE PIN: exactly one eviction, loud, naming the cap — and its
        // victim is the OLDEST insertion. Evicting the NEWEST would make
        // the cap a no-op for the very caller that hit it (the park just
        // registered would be the one thrown away).
        const evicted = lines.filter((line) =>
          line.key === "closure-replication-park-evicted"
        );
        expect(evicted.length).toBe(1);
        expect(evicted[0].line).toContain(`wanted=${libIdentities[0]}`);
        expect(evicted[0].line).toContain(`cap=${PARK_CAP}`);
        expect(evicted[0].line).not.toContain(
          libIdentities[EVICTION_LIB_COUNT - 1],
        );

        // THE FATE PIN — both halves driven by REAL supply records.
        const fate = await captureManagerLines(async () => {
          // (a) the EVICTED identity's supplier records (into G): nothing
          // wakes, because its park is gone. That is the documented cost of
          // an eviction — the child sits where the pre-ruling one-shot left
          // it, its loud failure line already logged.
          rt2.patternManager.replicatePatternToSpace(
            libPatterns[0] as never,
            spaceG,
            spaceA,
          );
          await rt2.patternManager.flushCompileCacheWrites();
          await rt2.patternManager.flushCompileCacheWrites();
          // (b) a SURVIVING park's identity records (into H): that one still
          // wakes and heals.
          rt2.patternManager.replicatePatternToSpace(
            libPatterns[1] as never,
            spaceH,
            spaceA,
          );
          await rt2.patternManager.flushCompileCacheWrites();
          await rt2.patternManager.flushCompileCacheWrites();
          await storageManager.synced();
        });

        // Neither half is vacuously quiet: both supply replications
        // succeeded, so both really recorded their identity — half (a)'s
        // silence is the eviction and nothing else.
        expect(
          fate.filter((line) => line.key === "closure-replication-failed")
            .length,
        ).toBe(0);
        const victimSupply = await readableClosure(
          rt2,
          spaceG,
          libIdentities[0],
        );
        expect(victimSupply.source).toContain(libIdentities[0]);

        const reissued = fate.filter((line) =>
          line.key === "closure-replication-reissued"
        );
        expect(reissued.length).toBe(1);
        expect(reissued[0].line).toContain(`wanted=${libIdentities[1]}`);
        expect(reissued[0].line).toContain(`trigger=persist-record:${spaceH}`);
        const healed = fate.filter((line) =>
          line.key === "closure-replication-healed"
        );
        expect(healed.length).toBe(1);
        expect(healed[0].line).toContain(`wanted=${libIdentities[1]}`);

        // The same asymmetry read off the store: the survivor's child
        // materialized in C; the evicted one's never did.
        const survivor = await readableClosure(rt2, spaceC, libIdentities[1]);
        expect(survivor.source).toContain(libIdentities[1]);
        const victim = await readableClosure(rt2, spaceC, libIdentities[0]);
        expect(victim.source).toEqual([]);
      } finally {
        await rt2.dispose();
      }
    },
  );
});
