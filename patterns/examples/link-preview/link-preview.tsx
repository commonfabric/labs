import { computed, type Default, NAME, pattern, UI } from "commonfabric";

export interface LinkPreviewInput {
  url: string | Default<"https://github.com">;
}

export const LinkPreview = pattern<LinkPreviewInput, LinkPreviewInput>(
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
