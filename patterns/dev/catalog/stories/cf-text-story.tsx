import { NAME, pattern, UI, type VNode, Writable } from "commonfabric";

import {
  Controls,
  SelectControl,
  SwitchControl,
  TextControl,
} from "../ui/controls/index.ts";

type TextVariant =
  | "caption"
  | "body-compact"
  | "body"
  | "body-large"
  | "heading-sm"
  | "heading-md"
  | "heading-lg";

type TextTone =
  | "default"
  | "muted"
  | "tertiary"
  | "disabled"
  | "primary"
  | "success"
  | "warning"
  | "error";

// deno-lint-ignore no-empty-interface
interface TextStoryInput {}
export interface TextStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<TextStoryInput, TextStoryOutput>(() => {
  const variant = new Writable<TextVariant>("body");
  const tone = new Writable<TextTone>("default");
  const block = new Writable(true);
  const truncate = new Writable(false);
  const content = new Writable("Text content");

  return {
    [NAME]: "cf-text Story",
    [UI]: (
      <div
        style={{
          padding: "1rem",
          display: "flex",
          flexDirection: "column",
          gap: "20px",
          maxWidth: "520px",
        }}
      >
        <cf-vstack gap="2">
          <cf-text variant="caption" tone="muted" block>
            Caption / metadata
          </cf-text>
          <cf-text variant="body-compact" block>
            Compact body text for dense lists and small controls.
          </cf-text>
          <cf-text variant="body" block>
            Body text for default descriptions, helper copy, and explanatory
            text.
          </cf-text>
          <cf-text variant="body-large" block>
            Large body text for more prominent supporting copy.
          </cf-text>
          <cf-text variant="heading-sm" block>
            Small heading-style text
          </cf-text>
          <cf-text variant="heading-md" block>
            Medium heading-style text
          </cf-text>
          <cf-text variant="heading-lg" block>
            Large heading-style text
          </cf-text>
        </cf-vstack>

        <cf-hstack
          gap="2"
          align="center"
          style="max-width: 240px; border: 1px dashed #cbd5e1; border-radius: 4px; padding: 4px;"
        >
          <cf-text truncate>
            Truncated text clips to a single line with an ellipsis, even inside
            a flex row like cf-hstack.
          </cf-text>
          <cf-badge size="xs" color="neutral">tag</cf-badge>
        </cf-hstack>

        <cf-card>
          <cf-vstack slot="content" gap="2">
            <cf-text
              variant={variant}
              tone={tone}
              block={block}
              truncate={truncate}
            >
              {content}
            </cf-text>
            <cf-text variant="caption" tone="muted" block>
              Use cf-label only when text labels a specific control.
            </cf-text>
          </cf-vstack>
        </cf-card>
      </div>
    ),
    controls: (
      <Controls>
        <>
          <SelectControl
            label="variant"
            description="Typography role"
            defaultValue="body"
            value={variant}
            items={[
              { label: "Caption", value: "caption" },
              { label: "Body compact", value: "body-compact" },
              { label: "Body", value: "body" },
              { label: "Body large", value: "body-large" },
              { label: "Heading sm", value: "heading-sm" },
              { label: "Heading md", value: "heading-md" },
              { label: "Heading lg", value: "heading-lg" },
            ]}
          />
          <SelectControl
            label="tone"
            description="Semantic color tone"
            defaultValue="default"
            value={tone}
            items={[
              { label: "Default", value: "default" },
              { label: "Muted", value: "muted" },
              { label: "Tertiary", value: "tertiary" },
              { label: "Disabled", value: "disabled" },
              { label: "Primary", value: "primary" },
              { label: "Success", value: "success" },
              { label: "Warning", value: "warning" },
              { label: "Error", value: "error" },
            ]}
          />
          <SwitchControl
            label="block"
            description="Display as block text"
            defaultValue="true"
            checked={block}
          />
          <SwitchControl
            label="truncate"
            description="Single-line ellipsis (implies block)"
            defaultValue="false"
            checked={truncate}
          />
          <TextControl
            label="children"
            description="Text content"
            defaultValue="Text content"
            value={content}
          />
        </>
      </Controls>
    ),
  };
});
