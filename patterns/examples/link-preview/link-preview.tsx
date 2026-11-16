import {
  computed,
  type Default,
  NAME,
  pattern,
  UI,
  type VNode,
} from "commonfabric";

export interface LinkPreviewInput {
  url?: string | Default<"https://github.com">;
}

export interface LinkPreviewOutput {
  [NAME]: string;
  [UI]: VNode;
  url: string;
}

export const LinkPreview = pattern<LinkPreviewInput, LinkPreviewOutput>(
  ({ url }) => {
    return {
      [NAME]: computed(() => `Link Preview: ${url}`),
      [UI]: (
        <cf-vstack style={{ gap: "12px" }}>
          <cf-input
            $value={url}
            placeholder="Enter a URL..."
          />
          <cf-link-preview url={url} />
        </cf-vstack>
      ),
      url,
    };
  },
);

export default LinkPreview;
