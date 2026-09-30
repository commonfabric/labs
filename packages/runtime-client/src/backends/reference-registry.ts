/**
 * Processor-scoped reference tokens preserve Runtime acquisition history across
 * worker messages without trusting serialized labels or widening scope caps.
 */

import { deepFreeze, taggedHashStringOf } from "@commonfabric/data-model";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import {
  type Cell,
  cellWriteSchema,
  getCarriedCfcLabelView,
  KeepAsCell,
  parseLink,
  type Runtime,
  type SigilLink,
} from "@commonfabric/runner";
import {
  assertSerializableReferenceScope,
  carryCfcReferenceProvenance,
  type CfcCellLinkRefPayload,
  cfcReferenceBindingMatches,
  clausesEqual,
  getCfcReferenceProvenance,
  immutableReferenceViewIdentity,
} from "@commonfabric/runner/cfc";
import { linkRefFrom, linkRefPayload } from "@commonfabric/runner/shared";

import type { CellRef } from "@/protocol/types.ts";

type WorkerLinkPayload = CfcCellLinkRefPayload & { cfcReferenceToken?: string };

/**
 * Acquisitions issued by one processor under its fixed security context.
 * Tokens carry no labels: they retrieve the worker's immutable acquisition.
 * Entries live for the processor's lifetime and identical acquisitions share
 * a token, so repeated subscriptions do not retain new records.
 */
export class ReferenceRegistry {
  readonly #runtime: Runtime;
  readonly #acquisitions = new Map<
    string,
    { link: SigilLink; cell: Cell<unknown> }
  >();
  readonly #tokens = new Map<string, string>();

  constructor(runtime: Runtime) {
    this.#runtime = runtime;
  }

  /** Expires all acquisitions when the owning processor is disposed. */
  clear(): void {
    this.#acquisitions.clear();
    this.#tokens.clear();
  }

  /** Exports a runtime carrier, retaining only worker-issued provenance. */
  exportLink(link: SigilLink, cell?: Cell<unknown>): SigilLink {
    const {
      cfcReferenceToken: _token,
      ...payload
    } = linkRefPayload(link) as WorkerLinkPayload;
    const clean = carryCfcReferenceProvenance(link, linkRefFrom(payload));
    if (this.#runtime.cfcFlowLabels !== "persist") return clean;
    const provenance = getCfcReferenceProvenance(clean);
    if (provenance === undefined) return clean;
    const normalized = parseLink(clean);
    if (
      !normalized.id || !normalized.space || normalized.scope === "inherit" ||
      !cfcReferenceBindingMatches(provenance, {
        ...normalized,
        id: normalized.id,
        space: normalized.space,
        scope: normalized.scope ?? "space",
      })
    ) {
      throw new Error("Reference acquisition does not match its binding");
    }
    // Display views never enter the acquisition retained inside the worker.
    const { cfcLabelView: _view, ...authority } = payload as typeof payload & {
      cfcLabelView?: unknown;
    };
    const sourceCell = cell ?? this.#runtime.getCellFromLink(clean);
    const sourceLink = sourceCell.getAsNormalizedFullLink();
    const sourceProvenance = getCfcReferenceProvenance(sourceCell);
    if (
      !cfcReferenceBindingMatches(provenance, {
        ...sourceLink,
        overwrite: normalized.overwrite,
      }) ||
      !deepEqual(sourceLink.scopeCaps ?? [], provenance.scopeCaps ?? []) ||
      !deepEqual(
        sourceProvenance?.selectionWitnesses ?? [],
        provenance.selectionWitnesses ?? [],
      ) ||
      !(provenance.originSpaces ?? []).every((space) =>
        sourceProvenance?.originSpaces?.includes(space)
      ) ||
      !provenance.confidentiality.every((clause) =>
        sourceProvenance?.confidentiality.some((candidate) =>
          clausesEqual(candidate, clause)
        )
      )
    ) {
      throw new Error("Retained cell does not match its reference acquisition");
    }
    const key = taggedHashStringOf({
      authority,
      provenance,
      writeSchema: cellWriteSchema(sourceCell),
      immutableReferences: immutableReferenceViewIdentity(
        getCarriedCfcLabelView(sourceCell),
      ),
      scopeCaps: sourceCell.getAsNormalizedFullLink().scopeCaps,
    });
    let token = this.#tokens.get(key);
    if (token === undefined) {
      token = crypto.randomUUID();
      this.#tokens.set(key, token);
      this.#acquisitions.set(
        token,
        {
          link: deepFreeze(
            carryCfcReferenceProvenance(clean, linkRefFrom(authority)),
          ),
          cell: sourceCell.withTx(undefined),
        },
      );
    }
    return linkRefFrom({ ...payload, cfcReferenceToken: token });
  }

  /** Restores an issued reference or a descendant, retaining its history. */
  importCell(ref: CellRef): Cell<unknown> {
    const token = ref.cfcReferenceToken;
    const acquired = typeof token === "string"
      ? this.#acquisitions.get(token)
      : undefined;
    if (acquired === undefined) {
      throw new Error("Reference acquisition token is missing or expired");
    }
    const base = parseLink(acquired.link);
    if (
      ref.id !== base.id || ref.space !== base.space ||
      ref.scope !== (base.scope ?? "space") ||
      (ref.overwrite === "redirect") !== (base.overwrite === "redirect") ||
      ref.path.length < base.path.length ||
      base.path.some((part, index) => part !== ref.path[index])
    ) {
      throw new Error("Reference acquisition token does not match its binding");
    }
    let cell = acquired.cell.withTx(undefined);
    for (const part of ref.path.slice(base.path.length)) cell = cell.key(part);
    // An echoed wire schema retains the issued handle's mutation declaration.
    // A different client projection is an explicit schema change.
    if (
      ref.schema !== undefined && (
        ref.path.length !== base.path.length ||
        !deepEqual(ref.schema, base.schema)
      )
    ) {
      cell = cell.asSchema(ref.schema);
    }
    return cell;
  }

  /** Imports a link without treating client display fields as authority. */
  importLink(link: SigilLink): SigilLink {
    const {
      cfcReferenceToken,
      cfcLabelView: _view,
      ...payload
    } = linkRefPayload(link) as WorkerLinkPayload;
    if (cfcReferenceToken === undefined) return linkRefFrom(payload);
    const normalized = parseLink(linkRefFrom(payload));
    if (
      !normalized.id || !normalized.space || normalized.scope === "inherit"
    ) {
      throw new Error("Reference acquisition token needs an absolute binding");
    }
    const cell = this.importCell({
      ...normalized,
      id: normalized.id,
      space: normalized.space,
      scope: normalized.scope ?? "space",
      cfcReferenceToken,
    });
    const effective = cell.getAsNormalizedFullLink();
    assertSerializableReferenceScope(effective.schema, effective.scopeCaps);
    const options = { includeSchema: true, keepAsCell: KeepAsCell.All };
    return normalized.overwrite === "redirect"
      ? cell.getAsWriteRedirectLink(options)
      : cell.getAsLink(options);
  }
}
