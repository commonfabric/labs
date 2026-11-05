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

export const TRUSTED_SAFE_LINK_SURFACE = "TrustedSafeLinkSurface";

const PREPARE_SAFE_LINK_ACTION = "TrustedPrepareSafeLink";
const RELEASE_SAFE_LINK_ACTION = "TrustedReleaseSafeLink";

export const prepareTrustedSafeLink = handler<
  void,
  {
    sourceUrl: Writable<string>;
    preparedSafeLink: Writable<string>;
  }
>((_, { sourceUrl, preparedSafeLink }) => {
  const [base] = sourceUrl.get().split("?");
  preparedSafeLink.set(base ? `${base}?view=summary` : "");
});

export const commitTrustedSafeLink = handler<
  void,
  {
    preparedSafeLink: Writable<string>;
    releasedSafeLink: Writable<string>;
  }
>((_, { preparedSafeLink, releasedSafeLink }) => {
  const prepared = preparedSafeLink.get().trim();
  releasedSafeLink.set(prepared ? `Released safe link ${prepared}` : "");
});

export interface TrustedSafeLinkSurfaceInput {
  sourceUrl: Writable<string>;
  preparedSafeLink: Writable<string>;
  releasedSafeLink: Writable<string>;
}

export interface TrustedSafeLinkSurfaceOutput {
  [NAME]: string;
  [UI]: VNode;
  sourceUrl: string;
  preparedSafeLink: TrustedActionWrite<
    string,
    typeof prepareTrustedSafeLink,
    typeof PREPARE_SAFE_LINK_ACTION,
    typeof TRUSTED_SAFE_LINK_SURFACE
  >;
  releasedSafeLink: TrustedActionWrite<
    string,
    typeof commitTrustedSafeLink,
    typeof RELEASE_SAFE_LINK_ACTION,
    typeof TRUSTED_SAFE_LINK_SURFACE
  >;
  prepareSafeLink: Stream<void>;
  releaseSafeLink: Stream<void>;
}

export const TrustedSafeLinkSurface = pattern<
  TrustedSafeLinkSurfaceInput,
  TrustedSafeLinkSurfaceOutput
>(({ sourceUrl, preparedSafeLink, releasedSafeLink }) => {
  const prepareSafeLink = prepareTrustedSafeLink({
    sourceUrl,
    preparedSafeLink,
  });
  const releaseSafeLink = commitTrustedSafeLink({
    preparedSafeLink,
    releasedSafeLink,
  });

  return {
    [NAME]: computed(() => "Trusted Safe Link Surface"),
    [UI]: (
      <cf-card
        id="trusted-safe-link-surface"
        data-ui-pattern={TRUSTED_SAFE_LINK_SURFACE}
        data-ui-event-integrity={TRUSTED_SAFE_LINK_SURFACE}
      >
        <cf-vstack slot="content" gap="3">
          <cf-heading level={3}>Trusted safe-link release</cf-heading>
          <cf-card data-ui-disclosure-kind="trusted-safe-link-disclosure">
            <cf-vstack slot="content" gap="1">
              <cf-label>
                This reviewed surface strips risky query material and releases
                only the safe summary link.
              </cf-label>
            </cf-vstack>
          </cf-card>
          <cf-vgroup gap="sm">
            <cf-label for="trusted-safe-link-source">Source URL</cf-label>
            <cf-input
              id="trusted-safe-link-source"
              $value={sourceUrl}
              placeholder="https://source.example.com/private/report"
            />
          </cf-vgroup>
          <cf-hstack gap="2" wrap>
            <cf-button
              data-ui-action={PREPARE_SAFE_LINK_ACTION}
              onClick={prepareSafeLink}
            >
              Prepare safe link
            </cf-button>
            <cf-button
              data-ui-action={RELEASE_SAFE_LINK_ACTION}
              onClick={releaseSafeLink}
            >
              Release safe link
            </cf-button>
          </cf-hstack>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-label>Prepared safe derivative</cf-label>
              <div id="trusted-safe-link-prepared">{preparedSafeLink}</div>
              <cf-label>Committed release</cf-label>
              <div id="trusted-safe-link-result">{releasedSafeLink}</div>
            </cf-vstack>
          </cf-card>
        </cf-vstack>
      </cf-card>
    ),
    sourceUrl,
    preparedSafeLink,
    releasedSafeLink,
    prepareSafeLink,
    releaseSafeLink,
  };
});
