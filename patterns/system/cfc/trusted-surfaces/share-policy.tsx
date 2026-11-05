import {
  computed,
  handler,
  NAME,
  pattern,
  Stream,
  type TrustedActionWrite,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

export const TRUSTED_SHARE_POLICY_SURFACE = "TrustedSharePolicySurface";

const SAVE_SHARE_POLICY_ACTION = "TrustedSaveSharePolicy";

export const saveTrustedSharePolicy = handler<
  void,
  {
    policyAudience: Writable<string>;
    policyScope: Writable<string>;
    savedSharePolicy: Writable<string>;
  }
>((_, { policyAudience, policyScope, savedSharePolicy }) => {
  const audience = policyAudience.get().trim() || "internal";
  const scope = policyScope.get().trim() || "shared";
  savedSharePolicy.set(`Share policy saved for ${audience} (${scope})`);
});

export interface TrustedSharePolicySurfaceInput {
  policyAudience: Writable<string>;
  policyScope: Writable<string>;
  savedSharePolicy: Writable<string>;
}

export interface TrustedSharePolicySurfaceOutput {
  [NAME]: string;
  [UI]: VNode;
  savedSharePolicy: TrustedActionWrite<
    string,
    typeof saveTrustedSharePolicy,
    typeof SAVE_SHARE_POLICY_ACTION,
    typeof TRUSTED_SHARE_POLICY_SURFACE
  >;
  saveSharePolicy: Stream<void>;
}

export const TrustedSharePolicySurface = pattern<
  TrustedSharePolicySurfaceInput,
  TrustedSharePolicySurfaceOutput
>(({ policyAudience, policyScope, savedSharePolicy }) => {
  const saveSharePolicy = saveTrustedSharePolicy({
    policyAudience,
    policyScope,
    savedSharePolicy,
  });

  return {
    [NAME]: computed(() => "Trusted Share Policy Surface"),
    [UI]: (
      <cf-card
        id="trusted-share-policy-surface"
        data-ui-pattern={TRUSTED_SHARE_POLICY_SURFACE}
        data-ui-event-integrity={TRUSTED_SHARE_POLICY_SURFACE}
      >
        <cf-vstack slot="content" gap="3">
          <cf-heading level={3}>Trusted share policy</cf-heading>
          <cf-card data-ui-disclosure-kind="trusted-share-policy-disclosure">
            <cf-vstack slot="content" gap="1">
              <cf-label>
                Persist a policy that governs the audience or scope of sharing.
              </cf-label>
            </cf-vstack>
          </cf-card>
          <cf-vgroup gap="sm">
            <cf-label for="trusted-share-policy-audience">Audience</cf-label>
            <cf-input
              id="trusted-share-policy-audience"
              $value={policyAudience}
              placeholder="internal"
            />
          </cf-vgroup>
          <cf-vgroup gap="sm">
            <cf-label for="trusted-share-policy-scope">Scope</cf-label>
            <cf-input
              id="trusted-share-policy-scope"
              $value={policyScope}
              placeholder="shared notes"
            />
          </cf-vgroup>
          <cf-button
            data-ui-action={SAVE_SHARE_POLICY_ACTION}
            onClick={saveSharePolicy}
          >
            Save policy
          </cf-button>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-label>Saved policy</cf-label>
              <div id="trusted-share-policy-result">{savedSharePolicy}</div>
            </cf-vstack>
          </cf-card>
        </cf-vstack>
      </cf-card>
    ),
    savedSharePolicy,
    saveSharePolicy,
  };
});
