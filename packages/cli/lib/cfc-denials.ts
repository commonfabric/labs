/**
 * Prints each CFC denial as it happens, with the inputs behind it. It is what
 * `cf test --cfc-denials` turns on. Every denial is printed, a repeat of an
 * earlier one included, whichever gate made it and whether or not the
 * transaction it refused is retried.
 */

import { toCompactDebugString } from "@commonfabric/data-model";
import {
  addCfcDenialListener,
  type CfcDenial,
  type CfcRefusalDetail,
} from "@commonfabric/runner/cfc";

/** Input keys {@link formatCfcDenial} lays out rather than renders whole. */
const LAID_OUT_KEYS = new Set(["reasons", "refusals"]);

/**
 * Returns the lines that describe one denial: a heading naming its kind, then
 * each reason, with the structured refusal detail paired to it indented
 * beneath, then each remaining input on a line of its own.
 */
export function formatCfcDenial(denial: CfcDenial): string[] {
  const { inputs } = denial;
  const lines = [`CFC denied (${denial.code}): ${denial.summary}`];
  const reasons = Array.isArray(inputs.reasons) ? inputs.reasons : [];
  // A gate that supplies `refusals` supplies them as `CfcRefusalDetail`s.
  const refusals =
    (Array.isArray(inputs.refusals)
      ? inputs.refusals
      : []) as readonly CfcRefusalDetail[];
  for (const reason of reasons) {
    lines.push(`  - ${String(reason)}`);
    for (const detail of refusals) {
      if (detail.reason === reason) lines.push(...formatDetail(detail));
    }
  }
  for (const [key, value] of Object.entries(inputs)) {
    if (LAID_OUT_KEYS.has(key) || value === undefined) continue;
    lines.push(`  ${key}: ${toCompactDebugString(value)}`);
  }
  return lines;
}

/**
 * Prints, through `print`, the lines {@link formatCfcDenial} returns for
 * every denial from now on, until the returned function is called.
 */
export function printCfcDenials(print: (line: string) => void): () => void {
  return addCfcDenialListener((denial) => {
    for (const line of formatCfcDenial(denial)) print(line);
  });
}

/**
 * Helper for {@link formatCfcDenial}, which describes one structured detail:
 * the gate, what it refused, and the reads that carried the offending
 * clauses.
 */
function formatDetail(detail: CfcRefusalDetail): string[] {
  const refused = detail.target !== undefined
    ? ` a write to ${formatAddress(detail.target)}`
    : detail.sink !== undefined
    ? ` a release to sink \`${detail.sink}\``
    : "";
  const lines = [
    `    ${detail.gate} refused${refused}; offending: ${
      detail.offendingAtoms.join(", ")
    } (attribution: ${detail.attribution})`,
  ];
  for (const input of detail.inputs) {
    lines.push(
      `      read ${formatAddress(input.read)}, label at \`/${
        input.labelPath.join("/")
      }\`: ${input.atoms.join(", ")}`,
    );
  }
  return lines;
}

/** Helper for {@link formatDetail}, which renders one address. */
function formatAddress(
  address: CfcRefusalDetail["inputs"][number]["read"],
): string {
  return `\`${address.id}\` at \`/${address.path.join("/")}\``;
}
