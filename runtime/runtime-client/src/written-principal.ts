/**
 * The principal a value's own cell represents, and whom a value represents,
 * as a host reads them through the cell handles a render binds:
 * `observeWrittenPrincipal()`, which reports a cell's value with the
 * principal its own cell represents, as the worker reads it by the rule
 * `cfc/written-principal.ts` in the runner states; and
 * `observeRepresentedPrincipal()`, which reports the principal a value's
 * label names, as a profile's owner is read. `cf-profile-badge`
 * decides a profile's face from the first, and a host that draws no Lit
 * component, such as one that shows a profile's face, composes the two.
 */

import { isObjectNotArray } from "@commonfabric/js-values/types";
import {
  isWrittenProfileName,
  ownerPrincipalFromLabel,
} from "@commonfabric/runner/cfc/represents-principal";
import type { JSONSchema } from "@commonfabric/runner/shared";

import type { CellHandle } from "./cell-handle.ts";

/**
 * The part of a value whose label `observeRepresentedPrincipal()` reads: its
 * `name`, which says which of the label's claims count.
 */
const NAME_SCHEMA = {
  type: "object",
  properties: { name: { type: "string" } },
} as const satisfies JSONSchema;

/**
 * Watches `cell` and reports to `onPrincipal` the one principal its label
 * names as the one its value represents, read as `cf-profile-badge` reads the
 * principal its seal shows (`ownerPrincipalFromLabel()`), until the returned
 * function is called: for a profile, whose profile it is. A value holding a
 * written `name` is read by the claims on its root and its `name`, and any
 * other by every claim its label holds. Nothing is reported until the cell
 * delivers the label the worker read with its value, or the worker refuses
 * it, so that `undefined` never means that the label has yet to load. After
 * that, it is `undefined` when the label names no single principal, for a
 * cell the worker refuses, and while the label the handle holds is not the
 * one the worker read with its value, as after a write through the handle.
 */
export const observeRepresentedPrincipal = (
  cell: CellHandle<unknown>,
  onPrincipal: (principal: string | undefined) => void,
): () => void => {
  let decided = false;
  const report = (principal: string | undefined) => {
    decided = true;
    onPrincipal(principal);
  };
  return cell.asSchema<{ name?: string }>(NAME_SCHEMA).subscribe(
    (value, label, delivery) => {
      if (delivery?.cfcLabelCurrent === true) {
        report(ownerPrincipalFromLabel(
          label,
          isWrittenProfileName(
            isObjectNotArray(value) ? value.name : undefined,
          ),
        ));
      } else if (decided) {
        report(undefined);
      }
    },
    { includeCfcLabel: true, onRefused: () => report(undefined) },
  );
};

/** What `observeWrittenPrincipal()` reports each time it decides. */
export type WrittenValue<T> = {
  /** The value the worker read with the principal. */
  readonly value: T | undefined;
  /** The principal the value's own cell represents, if its label names one. */
  readonly principal: string | undefined;
};

/** What a cell the worker refuses, or one held without its principal, reports. */
const NOTHING_WRITTEN = { value: undefined, principal: undefined } as const;

/**
 * Watches `cell` and reports to `onWritten` its value and the principal its
 * own cell represents, until the returned function is called. The worker
 * reads the principal with each value it delivers, by the rule
 * `cfc/written-principal.ts` in the runner states: the one principal the
 * label of the cell a write to `cell` lands in names, when the value is the
 * whole of that cell and no link stored there leads elsewhere, and none
 * otherwise.
 *
 * Nothing is reported until the cell delivers the principal the worker read
 * with its value, or the worker refuses it. After that, neither value nor
 * principal is reported for a cell the worker refuses, nor while the value
 * the handle holds is not the one the worker read the principal with, as
 * after a write through the handle, until the worker delivers the cell again.
 */
export const observeWrittenPrincipal = <T>(
  cell: CellHandle<T>,
  onWritten: (written: WrittenValue<T>) => void,
): () => void => {
  let decided = false;
  const report = (written: WrittenValue<T>) => {
    decided = true;
    onWritten(written);
  };
  return cell.subscribe((value, _label, delivery) => {
    if (delivery?.cfcLabelCurrent === true) {
      report({ value, principal: delivery.writtenPrincipal });
    } else if (decided) {
      report(NOTHING_WRITTEN);
    }
  }, {
    includeWrittenPrincipal: true,
    onRefused: () => report(NOTHING_WRITTEN),
  });
};
