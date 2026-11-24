import { NAME, pattern, UI, type VNode, Writable } from "commonfabric";
import {
  Controls,
  SelectControl,
  SwitchControl,
  TextControl,
} from "../ui/controls/index.ts";

// deno-lint-ignore no-empty-interface
interface CodeEditorStoryInput {}
export interface CodeEditorStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<CodeEditorStoryInput, CodeEditorStoryOutput>(() => {
  const value = new Writable("## Hello, world!");
  const language = new Writable<
    | "text/javascript"
    | "text/markdown"
    | "application/json"
    | "text/css"
    | "text/html"
    | "text/x.jsx"
    | "text/x.typescript"
  >("text/markdown");
  const disabled = new Writable(false);
  const readonly = new Writable(false);
  const placeholder = new Writable("Start writing...");
  const timingStrategy = new Writable<
    "immediate" | "debounce" | "throttle" | "blur"
  >("debounce");
  const timingDelay = new Writable(500);
  const wordWrap = new Writable(true);
  const lineNumbers = new Writable(false);
  const maxLineWidth = new Writable<number | string | undefined>(undefined);
  const tabSize = new Writable(2);
  const tabIndent = new Writable(true);
  const theme = new Writable<"light" | "dark">("light");
  const mode = new Writable<"code" | "prose">("prose");
  const autofocus = new Writable(false);
  const cursorPosition = new Writable<"start" | "end">("start");
  const pattern = new Writable("catalog");
  const mentionableData = [
    { [NAME]: "Design System" },
    { [NAME]: "Runtime Docs" },
    { [NAME]: "Patterns Catalog" },
  ];
  const mentionedData = [{ [NAME]: "Design System" }];
  const mentionable = new Writable<typeof mentionableData | undefined>(
    mentionableData,
  );
  const mentioned = new Writable<typeof mentionedData | undefined>(undefined);

  return {
    [NAME]: "cf-code-editor Story",
    [UI]: (
      <div style={{ padding: "1rem" }}>
        <div
          style={{
            marginBottom: "0.75rem",
            padding: "0.75rem",
            border: "1px solid #e2e8f0",
            borderRadius: "8px",
            background: "#f8fafc",
            fontSize: "13px",
            lineHeight: "1.5",
            color: "#334155",
          }}
        >
          Switching <code>mode</code> from <code>code</code> to{" "}
          <code>prose</code>{" "}
          changes this component from a syntax-focused code editor to a markdown
          prose editor experience. For inline markdown rendering in prose mode,
          set <code>language</code> to <code>text/markdown</code>.
        </div>
        <div style={{ height: "320px", border: "1px solid #e2e8f0" }}>
          <cf-code-editor
            $value={value}
            language={language}
            disabled={disabled}
            readonly={readonly}
            placeholder={placeholder}
            timingStrategy={timingStrategy}
            timingDelay={timingDelay}
            $mentionable={mentionable}
            $mentioned={mentioned}
            $pattern={pattern}
            lineNumbers={lineNumbers}
            wordWrap={wordWrap}
            maxLineWidth={maxLineWidth}
            tabSize={tabSize}
            tabIndent={tabIndent}
            theme={theme}
            mode={mode}
            autofocus={autofocus}
            cursorPosition={cursorPosition}
            style="height: 100%;"
          />
        </div>
      </div>
    ),
    controls: (
      <Controls>
        <>
          <TextControl
            label="value"
            description="Editor content"
            defaultValue="## Hello, world!"
            value={value}
          />
          <TextControl
            label="placeholder"
            description="Placeholder text when empty"
            defaultValue="Start writing..."
            value={placeholder}
          />
          <SelectControl
            label="mode"
            description="Editor behavior preset"
            defaultValue="prose"
            value={mode}
            items={[
              { label: "Code", value: "code" },
              { label: "Prose", value: "prose" },
            ]}
          />
          <SelectControl
            label="theme"
            description="Visual theme mode"
            defaultValue="light"
            value={theme}
            items={[
              { label: "Light", value: "light" },
              { label: "Dark", value: "dark" },
            ]}
          />
          <SelectControl
            label="language"
            description="Editor syntax mode (MIME)"
            defaultValue="text/markdown"
            value={language}
            items={[
              { label: "JavaScript", value: "text/javascript" },
              { label: "TypeScript", value: "text/x.typescript" },
              { label: "JSX", value: "text/x.jsx" },
              { label: "Markdown", value: "text/markdown" },
              { label: "JSON", value: "application/json" },
              { label: "CSS", value: "text/css" },
              { label: "HTML", value: "text/html" },
            ]}
          />
          <SelectControl
            label="timingStrategy"
            description="Input update strategy"
            defaultValue="debounce"
            value={timingStrategy}
            items={[
              { label: "Immediate", value: "immediate" },
              { label: "Debounce", value: "debounce" },
              { label: "Throttle", value: "throttle" },
              { label: "Blur", value: "blur" },
            ]}
          />
          <SelectControl
            label="timingDelay"
            description="Delay in ms for debounce/throttle"
            defaultValue="500"
            value={timingDelay}
            items={[
              { label: "100 ms", value: 100 },
              { label: "250 ms", value: 250 },
              { label: "500 ms", value: 500 },
              { label: "1000 ms", value: 1000 },
            ]}
          />
          <SelectControl
            label="maxLineWidth"
            description="Optional max line width"
            defaultValue="unset"
            value={maxLineWidth}
            items={[
              { label: "Unset", value: undefined },
              { label: "72", value: 72 },
              { label: "80", value: 80 },
              { label: "100", value: 100 },
              { label: "65ch", value: "65ch" },
              { label: "700px", value: "700px" },
            ]}
          />
          <SelectControl
            label="tabSize"
            description="Spaces shown for a tab"
            defaultValue="2"
            value={tabSize}
            items={[
              { label: "2", value: 2 },
              { label: "4", value: 4 },
              { label: "8", value: 8 },
            ]}
          />
          <TextControl
            label="pattern"
            description="Pattern piece id for backlink context"
            defaultValue="catalog"
            value={pattern}
          />
          <SelectControl
            label="mentionable"
            description="Mention candidates for @/[[ completion"
            defaultValue="sample list"
            value={mentionable}
            items={[
              { label: "Sample list", value: mentionableData },
              { label: "None", value: undefined },
            ]}
          />
          <SelectControl
            label="mentioned"
            description="Cell of currently mentioned pieces"
            defaultValue="unset"
            value={mentioned}
            items={[
              { label: "Unset", value: undefined },
              { label: "Sample", value: mentionedData },
            ]}
          />
          <SwitchControl
            label="disabled"
            description="Disables editor interaction"
            defaultValue="false"
            checked={disabled}
          />
          <SwitchControl
            label="readonly"
            description="Locks editing but keeps selection/copy"
            defaultValue="false"
            checked={readonly}
          />
          <SwitchControl
            label="lineNumbers"
            description="Shows line number gutter"
            defaultValue="false"
            checked={lineNumbers}
          />
          <SwitchControl
            label="wordWrap"
            description="Soft wrap long lines"
            defaultValue="true"
            checked={wordWrap}
          />
          <SwitchControl
            label="tabIndent"
            description="Indent using Tab key"
            defaultValue="true"
            checked={tabIndent}
          />
          <SwitchControl
            label="autofocus"
            description="Auto-focus editor on mount"
            defaultValue="false"
            checked={autofocus}
          />
          <SelectControl
            label="cursorPosition"
            description="Initial cursor position"
            defaultValue="start"
            value={cursorPosition}
            items={[
              { label: "Start", value: "start" },
              { label: "End", value: "end" },
            ]}
          />
        </>
      </Controls>
    ),
  };
});
