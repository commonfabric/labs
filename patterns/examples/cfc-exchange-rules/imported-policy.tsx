/**
 * A message protected by the exchange rules defined in another module, showing
 * that a pattern can apply a policy it imports rather than declaring its own.
 *
 * Demonstrates reusing `directReleaseRules` from the direct-release example
 * through `Confidential` and `PolicyOf`.
 */
import {
  type Confidential,
  Default,
  NAME,
  pattern,
  UI,
  type VNode,
} from "commonfabric";
import type { PolicyOf } from "commonfabric/cfc";
import { directReleaseRules } from "./direct-release.tsx";

interface ImportedPolicyInput {
  message?: Default<string, "Protected by the defining module's rules">;
}

export interface ImportedPolicyOutput {
  [NAME]: string;
  [UI]: VNode;
  message: Confidential<
    string,
    readonly [PolicyOf<typeof directReleaseRules>]
  >;
}

const ImportedPolicy = pattern<ImportedPolicyInput, ImportedPolicyOutput>(
  ({ message }) => ({
    [NAME]: "Imported direct CFC policy",
    [UI]: <div id="imported-policy-message">{message}</div>,
    message,
  }),
);

export default ImportedPolicy;
