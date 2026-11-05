import {
  computed,
  type Default,
  ifElse,
  NAME,
  pattern,
  UI,
  type VNode,
} from "commonfabric";

type ImageInput = {
  url: string | Default<"">;
  caption: string | Default<"">;
};

export type ImageOutput = {
  [NAME]: string;
  [UI]: VNode;
  url: string;
  caption: string;
};

export default pattern<ImageInput, ImageOutput>(({ url, caption }) => {
  const hasCaption = computed(() => !!caption);
  const displayName = computed(() => caption || "Image");

  return {
    [NAME]: displayName,
    [UI]: (
      <cf-screen>
        <cf-vstack gap="2" style={{ alignItems: "center" }}>
          <img
            src={url}
            alt={caption || "Image"}
            style={{
              maxWidth: "100%",
              width: "100%",
              height: "auto",
              borderRadius: "8px",
              objectFit: "contain",
            }}
          />
          {ifElse(
            hasCaption,
            <div
              style={{
                fontSize: "14px",
                color: "var(--cf-colors-gray-500)",
                textAlign: "center",
                padding: "4px 0",
              }}
            >
              {caption}
            </div>,
            null,
          )}
        </cf-vstack>
      </cf-screen>
    ),
    url,
    caption,
  };
});
