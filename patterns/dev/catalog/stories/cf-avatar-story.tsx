import { NAME, pattern, UI, type VNode, Writable } from "commonfabric";

import { Controls, SelectControl, TextControl } from "../ui/controls/index.ts";

// Self-contained avatar images (data-URI SVG) so the story renders with no
// network access / CSP allowance required.
const svgAvatar = (rgb: string, label: string): string =>
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96">` +
      `<rect width="96" height="96" rx="14" fill="${rgb}"/>` +
      `<text x="48" y="50" font-family="sans-serif" font-size="40" ` +
      `font-weight="600" fill="white" text-anchor="middle" ` +
      `dominant-baseline="central">${label}</text></svg>`,
  );

const ADA_IMG = svgAvatar("rgb(99,102,241)", "AL");

const sizeItems = [
  { label: "xs", value: "xs" },
  { label: "sm", value: "sm" },
  { label: "md", value: "md" },
  { label: "lg", value: "lg" },
  { label: "xl", value: "xl" },
];

// deno-lint-ignore no-empty-interface
interface AvatarStoryInput {}
export interface AvatarStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

const sectionLabel = {
  fontSize: "0.75rem",
  fontWeight: "600",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: "#6b7280",
  margin: "0 0 8px",
};

export default pattern<AvatarStoryInput, AvatarStoryOutput>(() => {
  const src = new Writable("");
  const name = new Writable("Ada Lovelace");
  const size = new Writable<"xs" | "sm" | "md" | "lg" | "xl">("lg");
  const shape = new Writable<"circle" | "square">("circle");

  return {
    [NAME]: "cf-avatar Story",
    [UI]: (
      <div
        style={{
          padding: "1.5rem",
          display: "flex",
          flexDirection: "column",
          gap: "28px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
          <cf-avatar src={src} name={name} size={size} shape={shape} />
          <span style={{ fontSize: "0.875rem", color: "#6b7280" }}>
            Leave “src” empty for initials; paste an image URL or an emoji.
          </span>
        </div>

        <div>
          <p style={sectionLabel}>Render modes — image · glyph · initials</p>
          <div style={{ display: "flex", gap: "16px", alignItems: "center" }}>
            <cf-avatar size="lg" name="Ada Lovelace" src={ADA_IMG} />
            <cf-avatar size="lg" name="Grace Hopper" src="🦊" />
            <cf-avatar size="lg" name="Alan Turing" />
          </div>
        </div>

        <div>
          <p style={sectionLabel}>Sizes — xs · sm · md · lg · xl</p>
          <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
            <cf-avatar size="xs" name="Ada Lovelace" src={ADA_IMG} />
            <cf-avatar size="sm" name="Ada Lovelace" src={ADA_IMG} />
            <cf-avatar size="md" name="Ada Lovelace" src={ADA_IMG} />
            <cf-avatar size="lg" name="Ada Lovelace" src={ADA_IMG} />
            <cf-avatar size="xl" name="Ada Lovelace" src={ADA_IMG} />
          </div>
        </div>

        <div>
          <p style={sectionLabel}>Shapes — circle · square</p>
          <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
            <cf-avatar
              size="lg"
              shape="circle"
              name="Ada Lovelace"
              src={ADA_IMG}
            />
            <cf-avatar
              size="lg"
              shape="square"
              name="Ada Lovelace"
              src={ADA_IMG}
            />
            <cf-avatar size="lg" shape="circle" name="Grace Hopper" />
            <cf-avatar size="lg" shape="square" name="Grace Hopper" />
          </div>
        </div>
      </div>
    ),
    controls: (
      <Controls>
        <>
          <TextControl
            label="src"
            description="Image URL or emoji/glyph (empty → initials)"
            defaultValue=""
            value={src}
          />
          <TextControl
            label="name"
            description="Display name (drives initials + alt text)"
            defaultValue="Ada Lovelace"
            value={name}
          />
          <SelectControl
            label="size"
            description="Avatar size"
            defaultValue="lg"
            value={size}
            items={sizeItems}
          />
          <SelectControl
            label="shape"
            description="Avatar shape"
            defaultValue="circle"
            value={shape}
            items={[
              { label: "Circle", value: "circle" },
              { label: "Square", value: "square" },
            ]}
          />
        </>
      </Controls>
    ),
  };
});
