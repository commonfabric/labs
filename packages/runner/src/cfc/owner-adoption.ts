import { type FabricValue, valueEqual } from "@commonfabric/data-model";
import { isObjectOrArray } from "@commonfabric/utils/types";

import type { JSONSchema } from "../builder/types.ts";
import { recordRelevantSchemaWritePolicyInput } from "../cell.ts";
import { ContextualFlowControl } from "../cfc.ts";
import type { NormalizedFullLink } from "../link-utils.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { readStoredCfcMetadata } from "./metadata.ts";
import { loadStoredCfcEnvelope } from "./prepare.ts";
import { representsPrincipalSubject } from "./represents-principal.ts";
import { cfcSchemaEntries } from "./schema-label-view.ts";
import { runtimeWritePolicyAuthorization } from "./types.ts";

/** Reads a field's durable owner, rather than rebinding its owner placeholder. */
export function readOwnerFieldPolicy(
  tx: IExtendedStorageTransaction,
  source: NormalizedFullLink,
): { schema: JSONSchema; owner: string } {
  readStoredCfcMetadata(tx, source, { meta: {} });
  const envelope = loadStoredCfcEnvelope(tx, source);
  if (envelope.status !== "loaded") {
    throw new Error("The owner's stored policy is unavailable");
  }
  if (
    cfcSchemaEntries(envelope.schema).some((entry) =>
      entry.path.length < source.path.length &&
      entry.path.every((part, index) =>
        part === "*" || part === source.path[index]
      )
    )
  ) {
    throw new Error("Policy adoption does not support ancestor protection");
  }
  const schema = ContextualFlowControl.getSchemaAtPath(envelope.schema, [
    ...source.path,
  ]);
  const owners = new Set(
    envelope.metadata.labelMap.entries
      .filter((entry) =>
        (entry.origin === "declared" || entry.origin === undefined) &&
        valueEqual(entry.path, source.path)
      )
      .flatMap((entry) => entry.label.integrity ?? [])
      .flatMap((atom) => {
        const subject = representsPrincipalSubject(atom);
        return subject === undefined ? [] : [subject];
      }),
  );
  const owner = [...owners][0];
  const ifc = isObjectOrArray(schema) ? schema.ifc : undefined;
  const representation = ifc?.addIntegrity?.[0];
  const supportedClaims = ifc !== undefined &&
    valueEqual(
      Object.entries(ifc).filter(([, value]) => value !== undefined).map((
        [key],
      ) => key).sort(),
      ["addIntegrity", "ownerPrincipal", "writeAuthorizedBy"],
    ) &&
    ifc.addIntegrity?.length === 1 && isObjectOrArray(representation) &&
    valueEqual(Object.keys(representation).sort(), ["kind", "subject"]) &&
    representation.kind === "represents-principal" &&
    (representation.subject === owner ||
      valueEqual(representation.subject, { __ctCurrentPrincipal: true }));
  const declaredOwner = isObjectOrArray(schema)
    ? schema.ifc?.ownerPrincipal
    : undefined;
  if (
    !supportedClaims || owners.size !== 1 || !owner ||
    !isObjectOrArray(schema) ||
    schema.type !== "string" ||
    !(declaredOwner === owner ||
      valueEqual(declaredOwner, { __ctCurrentPrincipal: true })) ||
    schema.ifc?.writeAuthorizedBy === undefined ||
    schema.ifc.uiContract !== undefined
  ) {
    throw new Error(
      "The field has no unambiguous supported stored owner policy",
    );
  }
  return {
    schema,
    owner,
  };
}

/**
 * Explicitly accepts an unchanged value under an existing owner's field policy.
 * This host-only repair seam is not part of the pattern builder namespace.
 * The caller must verify in this transaction that `target` is a supported
 * backing cell reached from `source`, and validate the owner's inspection
 * receipt against that layout. This function checks the policy and value;
 * it does not establish the link between the two addresses.
 */
export function stageOwnerPolicyAdoption(
  tx: IExtendedStorageTransaction,
  source: NormalizedFullLink,
  target: NormalizedFullLink,
  expectedValue: FabricValue,
): void {
  // These reads are part of the repair's concurrency precondition, including
  // the metadata whose presence and policy the operation relies on.
  readStoredCfcMetadata(tx, target, { meta: {} });
  const { schema, owner } = readOwnerFieldPolicy(tx, source);
  if (loadStoredCfcEnvelope(tx, target).status !== "none") {
    throw new Error("Policy adoption requires an unlabeled target");
  }
  if (
    owner !== tx.getCfcState().trustSnapshot?.actingPrincipal ||
    source.space !== target.space || source.scope !== target.scope ||
    target.path.length !== 0
  ) {
    throw new Error(
      "Policy adoption requires the field's owner and a supported same-space string policy",
    );
  }
  if (!valueEqual(tx.readValueOrThrow(target), expectedValue)) {
    throw new Error("Policy adoption target changed after inspection");
  }
  recordRelevantSchemaWritePolicyInput(tx, target, schema);
  tx.recordCfcWritePolicyInput({
    kind: "owner-adoption",
    target: {
      space: target.space,
      id: target.id,
      scope: target.scope,
      path: [],
    },
    value: expectedValue,
    owner,
  }, runtimeWritePolicyAuthorization);
}
