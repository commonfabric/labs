/// <cts-enable />
import { type Confidential, Default, pattern } from "commonfabric";
import {
  cfcPattern,
  exchangeRule,
  exchangeRules,
  type PolicyOf,
  THIS_POLICY,
  v,
} from "commonfabric/cfc";

// A declaration of policy at module scope: it calls names of
// `commonfabric/cfc` and reads members of what they give, and no run of
// the pattern reads it.
export const releaseToReader = exchangeRule({
  appliesTo: THIS_POLICY,
  pre: {
    integrity: [
      cfcPattern.hasRole(v("reader"), THIS_POLICY.subject, "reader"),
    ],
  },
  post: {
    addAlternatives: [cfcPattern.user(v("reader"))],
  },
});

export const rules = exchangeRules([releaseToReader]);

interface Output {
  message: Confidential<string, readonly [PolicyOf<typeof rules>]>;
}

export default pattern<{ message?: Default<string, "none"> }, Output>(
  ({ message }) => ({ message }),
);
