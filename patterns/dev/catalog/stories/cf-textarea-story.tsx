import { NAME, pattern, UI, type VNode, Writable } from "commonfabric";
import { Controls, SwitchControl } from "../ui/controls/index.ts";

// deno-lint-ignore no-empty-interface
interface TextareaStoryInput {}
export interface TextareaStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<TextareaStoryInput, TextareaStoryOutput>(() => {
  const disabled = new Writable(false);

  return {
    [NAME]: "cf-textarea Story",
    [UI]: (
      <div
        style={{
          padding: "1rem",
          display: "flex",
          flexDirection: "column",
          gap: "16px",
          maxWidth: "400px",
        }}
      >
        <cf-textarea
          placeholder="Default textarea"
          rows={3}
          disabled={disabled}
        />
        <cf-textarea placeholder="Auto-resize textarea" rows={2} auto-resize />
        <cf-textarea placeholder="Disabled" disabled rows={2} />
      </div>
    ),
    controls: (
      <Controls>
        <SwitchControl
          label="disabled"
          description="Disables interaction"
          defaultValue="false"
          checked={disabled}
        />
      </Controls>
    ),
  };
});
