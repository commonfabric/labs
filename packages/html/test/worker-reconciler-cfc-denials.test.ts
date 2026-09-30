import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { resetCfcDenialAnnouncements } from "@commonfabric/runner/cfc";
import { getLogger } from "@commonfabric/utils/logger";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "../../runner/test/cfc-seed-envelope.ts";
import { patchableCell } from "../../runner/test/support/patchable-cell.ts";
import type { WorkerVNode } from "../src/worker/types.ts";
import { WorkerReconciler } from "../src/worker/reconciler.ts";
import type { VDomOp } from "../src/vdom-ops.ts";

// The render gate says what it turns away, and keeps the explanation out of
// everything it emits and everything it logs by default. The explanation names
// a label this viewer was not cleared to see, and both the emitted operations
// and the worker console belong to the page the gate scrubbed.
//
// `Deno.test` rather than `describe`/`it`: this package installs its fake
// clock in freeze-all mode, which hangs `settle()` off `Deno.TestContext`, and
// a `@std/testing/bdd` `it()` callback never receives that context.

Deno.test("worker reconciler CFC denials", async (t) => {
  const signer = await Identity.fromPassphrase(
    "worker reconciler cfc denials",
  );
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    storageManager,
    apiUrl: new URL("http://localhost"),
  });
  // The label the ceiling below will not admit. Its `class` is a string that
  // appears nowhere else, so a search of the emitted ops — or of the log —
  // for it is a search for the label having escaped.
  const secretAtom = {
    type: "https://commonfabric.org/cfc/atom/Resource",
    class: "OncologyReferralLetter",
    subject: signer.did(),
  };
  const signedReleaseAtom = { kind: "signed-release", subject: "release-2026" };

  const CEILING_BLOCK =
    "the render policy did not admit a cell's confidentiality label";
  const TEXT_BLOCK =
    "a cell's text does not carry the integrity this boundary requires";
  const LITERAL_BLOCK = "literal text cannot be endorsed";

  /** Write the confidential cell, seeding its schema on the first call. */
  const writeSecret = async (value: string, seed = false) => {
    const tx = runtime.edit();
    if (seed) writeSeedEnvelopeDoc(tx, signer.did());
    const secret = runtime.getCell<string>(
      signer.did(),
      "cfc-denials-secret",
      undefined,
      tx,
    );
    seedStoredEnvelope(tx, {
      space: signer.did(),
      id: secret.getAsNormalizedFullLink().id!,
      type: "application/json",
      path: [],
    }, {
      value,
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [{ path: [], label: { confidentiality: [secretAtom] } }],
        },
      },
    });
    expect((await tx.commit()).ok).toBeDefined();
  };

  const collectOps = () => {
    const all: VDomOp[] = [];
    return {
      onOps: (ops: VDomOp[]) => all.push(...ops),
      all,
      propValue: (key: string): string | undefined => {
        for (const op of all) {
          if (op.op === "set-prop" && op.key === key) return String(op.value);
        }
        return undefined;
      },
      texts: () =>
        all.flatMap((op) => op.op === "create-text" ? [op.text] : []),
    };
  };

  /**
   * Mount `tree`, settle, and hand back what the `cfc` logger said. `debug` is
   * what a developer turns on to see a decision's inputs.
   */
  const mounted = async (
    tree: WorkerVNode,
    options: {
      collector: ReturnType<typeof collectOps>;
      ceiling?: boolean;
      debug?: boolean;
      after?: () => Promise<void>;
    },
  ): Promise<string> => {
    const logger = getLogger("cfc");
    const level = logger.level;
    const stderrRoute = Deno.env.get("LOG_TO_STDERR");
    Deno.env.set("LOG_TO_STDERR", "0");
    const said: string[] = [];
    const real = globalThis.console;
    const capture = (...args: unknown[]) => {
      said.push(args.map((arg) => JSON.stringify(arg) ?? "").join(" "));
    };
    globalThis.console = {
      ...real,
      warn: capture,
      error: capture,
      info: capture,
      log: capture,
      debug: capture,
    } as Console;
    logger.level = options.debug ? "debug" : "info";
    resetCfcDenialAnnouncements();
    let cancel = () => {};
    try {
      cancel = new WorkerReconciler({
        onOps: options.collector.onOps,
        ...(options.ceiling
          ? { renderConfidentialityCeiling: { atoms: [] } }
          : {}),
      }).mount(tree);
      await t.settle();
      await options.after?.();
    } finally {
      cancel();
      globalThis.console = real;
      if (stderrRoute === undefined) Deno.env.delete("LOG_TO_STDERR");
      else Deno.env.set("LOG_TO_STDERR", stderrRoute);
      logger.level = level;
    }
    return said.join("\n");
  };

  try {
    await writeSecret("Referral: see attached", true);
    const unsignedTx = runtime.edit();
    runtime.getCell<string>(
      signer.did(),
      "cfc-denials-unsigned",
      undefined,
      unsignedTx,
    ).set("Unsigned note");
    expect((await unsignedTx.commit()).ok).toBeDefined();

    const confidential = runtime.getCell<string>(
      signer.did(),
      "cfc-denials-secret",
    );
    const unsignedText = runtime.getCell<string>(
      signer.did(),
      "cfc-denials-unsigned",
    );
    const confidentialTree: WorkerVNode = {
      type: "vnode",
      name: "div",
      props: {},
      children: [confidential as never],
    };

    await t.step("names a policy block, and not the label", async () => {
      const collector = collectOps();
      const said = await mounted(confidentialTree, {
        collector,
        ceiling: true,
      });
      expect(collector.texts()).toContain("Content hidden by policy");
      expect(collector.propValue("data-cfc-blocked-reason")).toBe("policy");
      // It said something — the silence is what this exists to fix …
      expect(said).toContain(CEILING_BLOCK);
      // … and it did not say what was withheld.
      expect(said).not.toContain("OncologyReferralLetter");
    });

    // A property is decided on what its read consumed, so the explanation of
    // one it withholds names those labels, and only at debug.
    await t.step("explains a property it withholds", async () => {
      const property: WorkerVNode = {
        type: "vnode",
        name: "span",
        props: { title: confidential as never },
        children: [],
      };
      const quiet = await mounted(property, {
        collector: collectOps(),
        ceiling: true,
      });
      expect(quiet).toContain(CEILING_BLOCK);
      expect(quiet).not.toContain("OncologyReferralLetter");
      const said = await mounted(property, {
        collector: collectOps(),
        ceiling: true,
        debug: true,
      });
      expect(said).toContain("OncologyReferralLetter");
      expect(said).toContain("consumed");
    });

    await t.step(
      "names the label beside the ceiling once raised to debug",
      async () => {
        const said = await mounted(confidentialTree, {
          collector: collectOps(),
          ceiling: true,
          debug: true,
        });
        expect(said).toContain("OncologyReferralLetter");
        expect(said).toContain("consumed");
      },
    );

    await t.step(
      "keeps the blocked label out of every operation it emits",
      async () => {
        const collector = collectOps();
        await mounted(confidentialTree, { collector, ceiling: true });
        const emitted = JSON.stringify(collector.all);
        expect(emitted).not.toContain("OncologyReferralLetter");
        expect(emitted).not.toContain("Referral: see attached");
      },
    );

    // The gate decides again on every update to a blocked cell, so announcing
    // once is what keeps the console from carrying a line per tick.
    await t.step(
      "announces a standing block once across the updates that re-decide it",
      async () => {
        const said = await mounted(confidentialTree, {
          collector: collectOps(),
          ceiling: true,
          after: async () => {
            for (let update = 0; update < 10; update++) {
              await writeSecret(`Referral: revision ${update}`);
              await t.settle();
            }
          },
        });
        expect(said.split(CEILING_BLOCK).length - 1).toBe(1);
        expect(said).not.toContain("OncologyReferralLetter");
      },
    );

    await t.step(
      "reports a render boundary whose children it replaces",
      async () => {
        const collector = collectOps();
        const said = await mounted({
          type: "vnode",
          name: "cf-cfc-render-boundary",
          props: { maxConfidentiality: [], $value: confidential as never },
          children: [confidential as never],
        }, { collector });
        expect(collector.texts()).toContain("Content hidden by policy");
        expect(said.split(CEILING_BLOCK).length - 1).toBe(1);
      },
    );

    // The gate blocks a cell whose label it cannot read, and reports the
    // decision it made without one.
    await t.step("names an unreadable label as the source", async () => {
      const unreadable = patchableCell(runtime.getCell<string>(
        signer.did(),
        "cfc-denials-unsigned",
      ));
      unreadable.resolveAsCell = () => {
        throw new Error("label resolution failed");
      };
      const collector = collectOps();
      const said = await mounted({
        type: "vnode",
        name: "div",
        props: {},
        children: [unreadable as never],
      }, { collector, ceiling: true, debug: true });
      expect(collector.texts()).toContain("Content hidden by policy");
      expect(said).toContain("unreadable");
    });

    // A boundary whose props arrive as a cell has no policy on its first pass,
    // so the cell child renders and is then blocked when the policy settles,
    // beside the boundary blocking its own children. Two gates decide; the
    // warning is written once, which is what reaches a console.
    await t.step(
      "announces a boundary whose props arrive as a cell once",
      async () => {
        const tx = runtime.edit();
        runtime.getCell<Record<string, unknown>>(
          signer.did(),
          "cfc-denials-boundary-props",
          undefined,
          tx,
        ).set({ maxConfidentiality: [], $value: confidential as never });
        expect((await tx.commit()).ok).toBeDefined();
        const props = runtime.getCell<Record<string, unknown>>(
          signer.did(),
          "cfc-denials-boundary-props",
        );
        const collector = collectOps();
        const said = await mounted({
          type: "vnode",
          name: "cf-cfc-render-boundary",
          props: props as never,
          children: [confidential as never],
        }, { collector });
        expect(
          collector.texts().filter((text) =>
            text === "Content hidden by policy"
          ),
        ).toHaveLength(1);
        expect(said.split(CEILING_BLOCK).length - 1).toBe(1);
      },
    );

    await t.step(
      "explains text a boundary's integrity floor rejects",
      async () => {
        const said = await mounted({
          type: "vnode",
          name: "cf-cfc-authorship",
          props: {
            verifyTextIntegrity: true,
            allowLiteralText: true,
            requiredTextIntegrity: signedReleaseAtom,
          },
          children: [unsignedText as never],
        }, { collector: collectOps(), debug: true });
        expect(said).toContain(TEXT_BLOCK);
        expect(said).toContain("signed-release");
      },
    );

    await t.step(
      "names the sink prop when integrity blocks a prop value rather than a child",
      async () => {
        const collector = collectOps();
        const said = await mounted({
          type: "vnode",
          name: "cf-cfc-authorship",
          props: {
            verifyTextIntegrity: true,
            allowLiteralText: true,
            requiredTextIntegrity: signedReleaseAtom,
          },
          children: [{
            type: "vnode",
            name: "cf-chat-message",
            props: { role: "assistant", content: unsignedText as never },
            children: [],
          }],
        }, { collector, debug: true });
        // A replaced prop is named on the node; the report says why.
        expect(collector.propValue("data-cfc-blocked-props")).toBe("content");
        expect(said).toContain(TEXT_BLOCK);
        expect(said).toContain("content");
      },
    );

    await t.step(
      "explains literal text a boundary admits none of",
      async () => {
        const said = await mounted({
          type: "vnode",
          name: "cf-cfc-authorship",
          props: {
            verifyTextIntegrity: true,
            requiredTextIntegrity: signedReleaseAtom,
          },
          children: ["a literal string"],
        }, { collector: collectOps(), debug: true });
        expect(said).toContain(LITERAL_BLOCK);
        expect(said).toContain("signed-release");
      },
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});
