import {
  type Confidential,
  Default,
  NAME,
  pattern,
  UI,
  type VNode,
} from "commonfabric";
import {
  cfcPattern,
  exchangeRule,
  exchangeRules,
  type PolicyOf,
  THIS_POLICY,
  v,
} from "commonfabric/cfc";

export const releaseToSpaceReader = exchangeRule({
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

export const directReleaseRules = exchangeRules([releaseToSpaceReader]);

interface DirectReleaseInput {
  message?: Default<string, "Private until reader evidence is present">;
}

export interface DirectReleaseOutput {
  [NAME]: string;
  [UI]: VNode;
  message: Confidential<
    string,
    readonly [PolicyOf<typeof directReleaseRules>]
  >;
}

const DirectRelease = pattern<DirectReleaseInput, DirectReleaseOutput>(
  ({ message }) => ({
    [NAME]: "Direct CFC policy release",
    [UI]: (
      <cf-screen title="Direct CFC policy release">
        <cf-vstack gap="3" style={{ padding: "1rem" }}>
          <cf-heading level={2}>Module-authored exchange rule</cf-heading>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-label>Policy-protected message</cf-label>
              <div id="direct-release-message">{message}</div>
            </cf-vstack>
          </cf-card>
        </cf-vstack>
      </cf-screen>
    ),
    message,
  }),
);

export default DirectRelease;
