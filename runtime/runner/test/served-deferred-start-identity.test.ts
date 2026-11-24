/**
 * A piece start that a serving runtime defers until the piece's execution
 * family lands seeds the piece's scoped defaults in the instances of the
 * principal whose run deferred it.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import {
  resolveScopeKey,
  type ScopeKeyIdentity,
} from "@commonfabric/memory/v2";
import * as Engine from "@commonfabric/memory/v2/engine";

import type { Cell } from "../src/cell.ts";
import { stampWaveRunContext } from "../src/executor/wave.ts";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { ServingWaves } from "./support/serving-waves.ts";

const signer = await Identity.fromPassphrase("served deferred start identity");
const visitor = await Identity.fromPassphrase(
  "served deferred start identity visitor",
);

/** A pattern holding one session-scoped cell with a default. */
const SESSION_TAB_PROGRAM = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: `/// <cts-enable />
      import { pattern, Writable } from "commonfabric";
      export default pattern<Record<string, never>>(() => ({
        tab: Writable.perSession.of<string>("overview"),
      }));`,
  }],
};

/** The same pattern with a second session-scoped cell added. */
const SESSION_TAB_AND_PANEL_PROGRAM = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: `/// <cts-enable />
      import { pattern, Writable } from "commonfabric";
      export default pattern<Record<string, never>>(() => ({
        tab: Writable.perSession.of<string>("overview"),
        panel: Writable.perSession.of<string>("closed"),
      }));`,
  }],
};

describe("served-deferred-start-identity", () => {
  let waves: ServingWaves;
  let creator: Runtime;
  let creatorManager: EmulatedStorageManager;

  beforeEach(async () => {
    waves = await ServingWaves.open(signer);
    creatorManager = EmulatedStorageManager.connectTo(waves.server, {
      as: signer,
      id: "creator",
    });
    creator = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: creatorManager,
    });
  });

  afterEach(async () => {
    await creator.dispose();
    await creatorManager.close();
    await waves.dispose();
  });

  /** The session instance of `cell`'s document that `identity` names. */
  const instanceOf = (cell: Cell<unknown>, identity: ScopeKeyIdentity) =>
    Engine.read(waves.engine, {
      id: cell.resolveAsCell().getAsNormalizedFullLink().id,
      scopeKey: resolveScopeKey("session", identity),
    } as never)?.value;

  /** Every scope key under which `cell`'s document holds a row. */
  const instancesOf = (cell: Cell<unknown>) =>
    (waves.engine.database.prepare(
      `SELECT scope_key FROM head WHERE id = :id AND op != 'delete'`,
    ).all({ id: cell.resolveAsCell().getAsNormalizedFullLink().id }) as Array<
      { scope_key: string }
    >).map((row) => row.scope_key).sort();

  /** Stands the piece up as the creator, under the one-cell pattern. */
  const createPiece = async () => {
    const compiled = await creator.patternManager.compilePattern(
      SESSION_TAB_PROGRAM,
      { space: waves.space },
    );
    const piece = creator.getCell(waves.space, "session tab holder");
    await creator.runSynced(piece, compiled, {});
    await creator.idle();
    await creatorManager.synced();
  };

  /**
   * Runs the piece on the serving runtime under `program`, inside a demanded
   * run acting as the visitor's session, and commits every wave that run
   * sets in motion. Returns the serving runtime's cell for the piece and the
   * identity the run was demanded under.
   */
  const runAsVisitor = async (program: typeof SESSION_TAB_PROGRAM) => {
    const { runtime } = waves;
    const compiled = await runtime.patternManager.compilePattern(program, {
      space: waves.space,
    });
    const piece = runtime.getCell(waves.space, "session tab holder");
    await piece.sync();
    waves.serve();
    const demanded: ScopeKeyIdentity = {
      principal: visitor.did(),
      sessionId: "visitor session",
    };
    const tx = runtime.edit();
    stampWaveRunContext(tx, {
      actionId: "demanded-run",
      kind: "derivation",
      scopeKeyIdentity: demanded,
    });
    runtime.run(tx, compiled, {}, piece);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await waves.commitAll();
    return { piece, demanded };
  };

  it("seeds a cold session default under the stored pattern in the demanding session's instance", async () => {
    // Under the pattern the piece's pointer names, the name-sync that
    // precedes the start seeds the default in a transaction of its own, and
    // the start's own transaction writes nothing scoped.

    await createPiece();
    const { piece, demanded } = await runAsVisitor(SESSION_TAB_PROGRAM);

    expect(instanceOf(piece.key("tab"), demanded)).toBe("overview");
    expect(instancesOf(piece.key("tab"))).toEqual([
      resolveScopeKey("session", creatorManager.scopeKeyIdentity()),
      resolveScopeKey("session", demanded),
    ].sort());
  });

  it("seeds the defaults the start initializes itself in the demanding session's instance and in no other", async () => {
    // Under a pattern other than the one the pointer names, the name-sync
    // leaves the seeding to the start, which seeds in the transaction it runs
    // in: the one that read the demanding session's instances. The wave
    // resolves those writes against the identity the start's stamp carries,
    // so a stamp carrying none lands them in the wave's own session instance.

    await createPiece();
    const { piece, demanded } = await runAsVisitor(
      SESSION_TAB_AND_PANEL_PROGRAM,
    );

    expect(instanceOf(piece.key("tab"), demanded)).toBe("overview");
    expect(instanceOf(piece.key("panel"), demanded)).toBe("closed");
    expect(instanceOf(piece.key("panel"), waves.scopeKeyIdentity))
      .toBeUndefined();
    expect(instancesOf(piece.key("tab"))).toEqual([
      resolveScopeKey("session", creatorManager.scopeKeyIdentity()),
      resolveScopeKey("session", demanded),
    ].sort());
    expect(instancesOf(piece.key("panel"))).toEqual([
      resolveScopeKey("session", demanded),
    ]);
  });
});
