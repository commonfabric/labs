import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { createSession, Identity } from "@commonfabric/identity";
import {
  type Cell,
  getPatternIdentityRef,
  getPatternSetupIdentityRef,
  Runtime,
  sendEvent,
  setPatternSource,
} from "@commonfabric/runner";
import { rawMetaWriteAuthorization } from "@commonfabric/runner/meta-seam";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { PiecesController } from "../src/ops/pieces-controller.ts";

const signer = await Identity.fromPassphrase("loom-root-upgrade");
const rootSchema = {
  type: "object",
  required: ["title", "panels", "addPiece", "retitleLoom"],
  properties: {
    title: { type: "string" },
    panels: { type: "array", items: { type: "unknown", asCell: ["cell"] } },
    addPiece: { asCell: ["stream"] },
    retitleLoom: { asCell: ["stream"] },
    retitlePanel: { asCell: ["stream"] },
    removePanel: { asCell: ["stream"] },
  },
} as const;

/** `panel` read as a panel's adder and title. */
const adderOf = (panel: Cell<unknown>) =>
  panel.asSchema(
    {
      type: "object",
      properties: {
        addedBy: { type: "string" },
        titleOverride: { type: "string" },
      },
    } as const,
  );

/**
 * The module identity `pattern`'s result schema names as the writer of a
 * panel's adder, `admitPanel`'s module.
 */
const adderWriterIdentity = (pattern: { resultSchema?: unknown }): unknown =>
  (pattern.resultSchema as {
    $defs?: {
      PanelAdderDid?: {
        ifc?: {
          writeAuthorizedBy?: {
            __ctWriterIdentityOf?: { moduleIdentity?: unknown };
          };
        };
      };
    };
  }).$defs?.PanelAdderDid?.ifc?.writeAuthorizedBy?.__ctWriterIdentityOf
    ?.moduleIdentity;

describe("loom-root-upgrade", () => {
  for (const mode of ["controller", "cold setup"] as const) {
    it(`preserves populated panels and their handlers through ${mode} with an added input`, async () => {
      const manager = StorageManager.emulate({ as: signer });
      let runtime = new Runtime({
        apiUrl: new URL("http://localhost:9999"),
        storageManager: manager,
      });
      try {
        const space = await runtime.createSpace();
        const pieces = new PiecesController(
          createSession({ identity: signer, spaceDid: space }),
          runtime,
        );
        await pieces.ready;
        const program = await resolveLocalProgram(
          runtime.harness.resolve.bind(runtime.harness),
          {
            root: fromFileUrl(new URL("../../../patterns/", import.meta.url)),
            main: fromFileUrl(
              new URL(
                "../../../patterns/system/loom/main.tsx",
                import.meta.url,
              ),
            ),
          },
        );
        const oldPattern = await runtime.patternManager.compilePattern(
          program,
          { space },
        );
        const root = await pieces.runPersistent(oldPattern, {}, "root-upgrade");
        await pieces.linkDefaultPattern(root);
        const output = root.asSchema(rootSchema);
        const target = runtime.getCell(space, "before-upgrade");
        // Registered through the controller, which records its principal as
        // the panel's adder.
        await pieces.add([target]);
        const [panel] = await output.key("panels").pull();
        const panelLink = panel.resolveAsCell().getAsNormalizedFullLink();
        // The panel's adder is stamped by `admitPanel`, under its module's
        // identity as it stands before the update.
        expect((await adderOf(panel.resolveAsCell()).pull()).addedBy).toBe(
          signer.did(),
        );
        const candidate = {
          ...program,
          files: program.files.map((file) =>
            file.name.endsWith("system/loom/schemas.tsx")
              ? {
                ...file,
                contents: file.contents.replace(
                  "export interface LoomInput {",
                  'export interface UpgradeNote { text: string; }\nexport interface LoomInput {\n  upgradeNote?: PerSpace<Writable<UpgradeNote | Default<{ text: "" }>>>;',
                ),
              }
              : file
          ),
        };
        const next = await runtime.patternManager.compilePattern(candidate, {
          space,
        });
        const nextRef = runtime.patternManager.getArtifactEntryRef(next)!;
        expect(nextRef).not.toEqual(getPatternIdentityRef(root));
        // `admitPanel`'s module imports the edited one, so its identity moves
        // with the edit, and the stored panel's stamp names the old one.
        expect(adderWriterIdentity(next)).toBeDefined();
        expect(adderWriterIdentity(next)).not.toEqual(
          adderWriterIdentity(oldPattern),
        );
        const link = root.getAsNormalizedFullLink();
        if (mode === "controller") {
          await (await pieces.get(link.id)).setPattern(candidate);
        } else {
          const swap = await runtime.editWithRetry((tx) => {
            root.withTx(tx).setMetaRaw(
              "patternIdentity",
              nextRef,
              rawMetaWriteAuthorization,
            );
            setPatternSource(root, tx, "system:system/loom/main.tsx");
          });
          expect(swap.error).toBeUndefined();
        }
        await runtime.dispose({ closeStorage: false });
        runtime = new Runtime({
          apiUrl: new URL("http://localhost:9999"),
          storageManager: manager,
        });
        const cold = runtime.getCellFromLink(link);
        const loaded = await runtime.patternManager.loadPatternByIdentity(
          nextRef.identity,
          nextRef.symbol,
          space,
        );
        expect(loaded).toBeDefined();
        // Setup precedes start, as it can when a daemon refreshes the root.
        await runtime.runSynced(cold, loaded!, undefined, {
          expectedPatternIdentity: nextRef,
        });
        expect(getPatternSetupIdentityRef(cold)).toEqual(nextRef);
        await runtime.start(cold);
        const reopened = cold.asSchema(rootSchema);
        const retained = await reopened.key("panels").pull();
        expect(retained).toHaveLength(1);
        expect(retained[0].resolveAsCell().getAsNormalizedFullLink()).toEqual(
          panelLink,
        );
        for (
          const [key, event] of [
            ["addPiece", { piece: runtime.getCell(space, "after-upgrade") }],
            ["retitleLoom", { title: "Upgraded Loom" }],
          ] as const
        ) {
          await new Promise<void>((resolve, reject) =>
            sendEvent(
              reopened.key(key),
              event,
              (tx) => {
                const status = tx.status();
                if (status.status === "error") reject(status.error);
                else resolve();
              },
              { eventId: `after-${key}`, session: signer.did() },
            )
          );
        }
        expect(await reopened.key("panels").pull()).toHaveLength(2);
        expect(await reopened.key("title").pull()).toBe("Upgraded Loom");
        // The panel added before the update keeps its adder, takes a title,
        // and its adder can still remove it, under the moved identity.
        const kept = runtime.getCellFromLink(panelLink);
        expect((await adderOf(kept).pull()).addedBy).toBe(signer.did());
        for (
          const [key, event] of [
            ["retitlePanel", { panel: kept, titleOverride: "Kept" }],
            ["removePanel", { panel: kept }],
          ] as const
        ) {
          await new Promise<void>((resolve, reject) =>
            sendEvent(
              reopened.key(key),
              event,
              (tx) => {
                const status = tx.status();
                if (status.status === "error") reject(status.error);
                else resolve();
              },
              { eventId: `old-panel-${key}`, session: signer.did() },
            )
          );
          if (key === "retitlePanel") {
            expect((await adderOf(kept).pull()).titleOverride).toBe("Kept");
          }
        }
        const remaining = await reopened.key("panels").pull();
        expect(remaining).toHaveLength(1);
        expect(
          remaining[0].resolveAsCell().getAsNormalizedFullLink(),
        ).not.toEqual(panelLink);
      } finally {
        await runtime.dispose();
        await manager.close();
      }
    });
  }
});
