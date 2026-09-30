import { assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { CFC_LABEL_READ_FAILED_ATOM } from "@commonfabric/runner/cfc";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "../../runner/test/cfc-seed-envelope.ts";
import { WorkerReconciler } from "../src/worker/reconciler.ts";
import type { RenderPolicy } from "../src/worker/types.ts";

// These tests drive the per-atom confidentiality admission logic synchronously,
// without the async mount/sink pipeline. The reconciler's render path reaches
// `canRenderCellUnderPolicy` / `atomRenderableUnderPolicy` only when a labeled
// value happens to be evaluated inside a sink callback before teardown, so the
// branches below (read-failure marker, author declassification, ceiling
// fallthrough, all-atoms-admitted loop exit) cover nondeterministically across
// runs. Calling the admission methods directly pins them to a fixed path.

// The admission checks, reached through the reconciler's accessor.
function admissionSeam(reconciler: WorkerReconciler) {
  return reconciler.accessForTestingOnly;
}

Deno.test("worker reconciler CFC atom admission", async (t) => {
  const signer = await Identity.fromPassphrase(
    "worker reconciler cfc atom admission",
  );
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    storageManager,
    apiUrl: new URL("http://localhost"),
  });

  // A plain (non-marker) confidentiality atom used across the declassify and
  // ceiling cases.
  const healthRecordAtom = {
    type: "https://commonfabric.org/cfc/atom/Resource",
    class: "SensitiveHealthRecord",
    subject: signer.did(),
  };

  try {
    const tx = runtime.edit();
    const secret = runtime.getCell<string>(
      signer.did(),
      "cfc-atom-admission-secret",
      undefined,
      tx,
    );
    const secretLink = secret.getAsNormalizedFullLink();
    writeSeedEnvelopeDoc(tx, signer.did());
    seedStoredEnvelope(tx, {
      space: signer.did(),
      id: secretLink.id!,
      type: "application/json",
      path: [],
    }, {
      value: "Sensitive diagnosis: migraine",
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [{
            path: [],
            label: { confidentiality: [healthRecordAtom] },
          }],
        },
      },
    });
    const commitResult = await tx.commit();
    assertEquals(commitResult.ok !== undefined, true);

    const confidential = runtime.getCell<string>(
      signer.did(),
      "cfc-atom-admission-secret",
    );

    const reconciler = new WorkerReconciler({ onOps: () => {} });
    const admission = admissionSeam(reconciler);

    await t.step(
      "read-failure marker atom is never admitted, even when the policy names it",
      () => {
        // The marker is UNGRANTABLE: a policy that lists it under BOTH
        // declassify and the ceiling must still reject it. This pins the
        // `deepEqual(atom, CFC_LABEL_READ_FAILED_ATOM) => false` branch.
        const policy: RenderPolicy = {
          maxConfidentiality: [CFC_LABEL_READ_FAILED_ATOM],
          declassifyConfidentiality: [CFC_LABEL_READ_FAILED_ATOM],
        };
        assertEquals(
          admission.atomRenderableUnderPolicy(
            CFC_LABEL_READ_FAILED_ATOM,
            policy,
          ),
          false,
        );
      },
    );

    await t.step(
      "an atom listed in declassifyConfidentiality is admitted",
      () => {
        // No ceiling admits this atom; only the author-declassify branch can.
        const policy: RenderPolicy = {
          maxConfidentiality: [],
          declassifyConfidentiality: [healthRecordAtom],
        };
        assertEquals(
          admission.atomRenderableUnderPolicy(healthRecordAtom, policy),
          true,
        );
      },
    );

    await t.step(
      "a non-declassified atom falls through to the ceiling and is admitted when within bound",
      () => {
        const policy: RenderPolicy = {
          maxConfidentiality: [healthRecordAtom],
          declassifyConfidentiality: [],
        };
        assertEquals(
          admission.atomRenderableUnderPolicy(healthRecordAtom, policy),
          true,
        );
      },
    );

    await t.step(
      "a non-declassified atom falls through to the ceiling and is rejected when above bound",
      () => {
        const policy: RenderPolicy = {
          maxConfidentiality: [],
          declassifyConfidentiality: [],
        };
        assertEquals(
          admission.atomRenderableUnderPolicy(healthRecordAtom, policy),
          false,
        );
      },
    );

    await t.step(
      "a cell whose only label atom is above the bound is blocked (loop rejects)",
      () => {
        // A false result here also confirms the label view was read (the
        // schema fallback for an unlabeled cell would return true), so the
        // admitted cases below genuinely exercise the per-atom loop.
        const policy: RenderPolicy = {
          maxConfidentiality: [],
          declassifyConfidentiality: [],
        };
        assertEquals(
          admission.canRenderCellUnderPolicy(confidential, policy),
          false,
        );
      },
    );

    await t.step(
      "a cell whose label atoms are all within the ceiling renders (loop exits true)",
      () => {
        const policy: RenderPolicy = {
          maxConfidentiality: [healthRecordAtom],
          declassifyConfidentiality: [],
        };
        assertEquals(
          admission.canRenderCellUnderPolicy(confidential, policy),
          true,
        );
      },
    );

    await t.step(
      "a cell whose label atoms are all declassified renders (loop exits true)",
      () => {
        const policy: RenderPolicy = {
          maxConfidentiality: [],
          declassifyConfidentiality: [healthRecordAtom],
        };
        assertEquals(
          admission.canRenderCellUnderPolicy(confidential, policy),
          true,
        );
      },
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});
