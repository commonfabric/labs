/**
 * A URL input with a rich preview of the linked page beneath it, defaulting
 * to a GitHub address. It demonstrates the `cf-link-preview` component bound
 * to a cell alongside a `cf-input` using `$value`.
 */
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
