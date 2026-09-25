/** Measures staged reference graph preparation, keeping setup outside timing. */
import { Session } from "node:inspector/promises";
import { Identity } from "@commonfabric/identity";
import type { JSONSchema } from "../../../../../packages/runner/src/builder/types.ts";
import { readStoredCfcMetadata } from "../../../../../packages/runner/src/cfc/metadata.ts";
import { recordReferencedArgumentFields } from "../../../../../packages/runner/src/cfc/reference-initialization.ts";
import { Runtime } from "../../../../../packages/runner/src/runtime.ts";
import { StorageManager } from "../../../../../packages/runner/src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase(
  "staged-reference-diamond-profile",
);
const space = signer.did();
const depths = (Deno.env.get("DEPTHS") ?? "2,4,6,8,10,12").split(",").map(
  Number,
);
const widths = (Deno.env.get("WIDTHS") ?? "1,2").split(",").map(Number);
const repeats = Number(Deno.env.get("REPEATS") ?? "3");
const orders = (Deno.env.get("ORDERS") ?? "bottom-up,top-down").split(",");
const profilePrefix = Deno.env.get("PROFILE_PREFIX");
let profileIndex = 0;
const profiler = profilePrefix ? new Session() : undefined;
if (profiler) {
  profiler.connect();
  await profiler.post("Profiler.enable");
}
const schema: JSONSchema = {
  type: "object",
  ifc: { integrity: ["object-proof"] },
};

async function measure(depth: number, width: number, order: string) {
  const manager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager: manager,
    cfcEnforcementMode: "enforce-explicit",
    cfcFlowLabels: "persist",
  });
  try {
    const seed = runtime.edit();
    const leaf = runtime.getCell(space, "leaf", {
      type: "object",
      ifc: { confidentiality: ["secret"] },
    }, seed);
    leaf.set({ value: "payload" });
    runtime.prepareTxForCommit(seed);
    const seeded = await seed.commit();
    if (seeded.error) throw seeded.error;
    const tx = runtime.edit();
    const nodes = Array.from(
      { length: depth },
      (_, index) => runtime.getCell(space, `node-${index}`, schema, tx),
    );
    const holder = runtime.getCell(space, "holder", schema, tx);
    const stages = nodes.map((node, index) => () => {
      const target = nodes[index + 1] ?? leaf.withTx(tx);
      const fields = Array.from({ length: width }, (_, j) => `p${j}`);
      node.set(Object.fromEntries(fields.map((key) => [key, target])));
      recordReferencedArgumentFields(
        tx,
        node.getAsNormalizedFullLink(),
        fields,
      );
    });
    stages.unshift(() => {
      holder.set({ argument: nodes[0] ?? leaf.withTx(tx) });
      recordReferencedArgumentFields(tx, holder.getAsNormalizedFullLink(), [
        "argument",
      ]);
    });
    for (const stage of order === "bottom-up" ? stages.toReversed() : stages) {
      stage();
    }
    const links = tx.getCfcState().writePolicyInputs.filter((input) =>
      input.kind === "link-write"
    ).length;
    runtime.resetCfcStats();
    if (profiler) {
      await profiler.post("Profiler.start");
    }
    const start = performance.now();
    runtime.prepareTxForCommit(tx);
    const elapsed = performance.now() - start;
    if (profiler) {
      const { profile } = await profiler.post("Profiler.stop");
      await Deno.writeTextFile(
        `${profilePrefix}-${depth}-${width}-${order}-${profileIndex++}.cpuprofile`,
        JSON.stringify(profile),
      );
    }
    const stats = runtime.getCfcStats();
    const result = await tx.commit();
    if (result.error) {
      throw result.error;
    }
    const inspect = runtime.edit();
    const views = [holder, ...nodes].map((node) =>
      readStoredCfcMetadata(inspect, node.getAsNormalizedFullLink())!.labelMap
    );
    inspect.abort();
    const serialized = JSON.stringify(views);
    const bytes = new TextEncoder().encode(serialized);
    const hash = [
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    ]
      .map((byte) =>
        byte.toString(16).padStart(2, "0")
      ).join("");
    const root = views[0].entries;
    const leaves = root.filter((entry) =>
      entry.path.length === depth + 1 &&
      entry.label.confidentiality?.includes("secret")
    );
    if (leaves.length !== width ** depth) {
      throw new Error(
        `Missing leaf labels: ${leaves.length} != ${width ** depth}`,
      );
    }
    return {
      depth,
      width,
      order,
      elapsed,
      links,
      rootEntries: root.length,
      totalEntries: views.reduce((sum, view) => sum + view.entries.length, 0),
      bytes: bytes.length,
      hash,
      stats,
    };
  } finally {
    await runtime.dispose();
  }
}

await measure(2, 2, "bottom-up");
for (let sample = 0; sample < repeats; sample++) {
  for (const depth of depths) {
    for (const width of widths) {
      for (const order of sample % 2 === 0 ? orders : orders.toReversed()) {
        console.log(
          JSON.stringify({ sample, ...await measure(depth, width, order) }),
        );
      }
    }
  }
}

profiler?.disconnect();
