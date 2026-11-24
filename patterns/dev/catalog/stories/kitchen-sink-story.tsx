import { NAME, pattern, UI, type VNode } from "commonfabric";

import ButtonStory from "./cf-button-story.tsx";
import CheckboxStory from "./cf-checkbox-story.tsx";
import CodeEditorStory from "./cf-code-editor-story.tsx";
import InputStory from "./cf-input-story.tsx";
import SelectStory from "./cf-select-story.tsx";
import SwitchStory from "./cf-switch-story.tsx";
import CardStory from "./cf-card-story.tsx";
import ModalStory from "./cf-modal-story.tsx";
import ProgressStory from "./cf-progress-story.tsx";
import VStackStory from "./cf-vstack-story.tsx";
import HStackStory from "./cf-hstack-story.tsx";
import VGroupStory from "./cf-vgroup-story.tsx";
import HGroupStory from "./cf-hgroup-story.tsx";
import VScrollStory from "./cf-vscroll-story.tsx";
import HScrollStory from "./cf-hscroll-story.tsx";
import TextareaStory from "./cf-textarea-story.tsx";
import MessageInputStory from "./cf-message-input-story.tsx";
import ToolbarStory from "./cf-toolbar-story.tsx";
import HeadingStory from "./cf-heading-story.tsx";
import LabelStory from "./cf-label-story.tsx";
import ChipStory from "./cf-chip-story.tsx";
import BadgeStory from "./cf-badge-story.tsx";
import AlertStory from "./cf-alert-story.tsx";
import SeparatorStory from "./cf-separator-story.tsx";
import MarkdownStory from "./cf-markdown-story.tsx";
import LoaderStory from "./cf-loader-story.tsx";
import SkeletonStory from "./cf-skeleton-story.tsx";
import CollapsibleStory from "./cf-collapsible-story.tsx";
import TabsStory from "./cf-tabs-story.tsx";
import ChartStory from "./cf-chart-story.tsx";

// deno-lint-ignore no-empty-interface
interface KitchenSinkStoryInput {}
export interface KitchenSinkStoryOutput {
  [NAME]: string;
  [UI]: VNode;
}

export default pattern<KitchenSinkStoryInput, KitchenSinkStoryOutput>(() => {
  const sections = [
    { label: "Button", node: ButtonStory({}) },
    { label: "Checkbox", node: CheckboxStory({}) },
    { label: "Code Editor", node: CodeEditorStory({}) },
    { label: "Input", node: InputStory({}) },
    { label: "Select", node: SelectStory({}) },
    { label: "Switch", node: SwitchStory({}) },
    { label: "Card", node: CardStory({}) },
    { label: "Modal", node: ModalStory({}) },
    { label: "Progress", node: ProgressStory({}) },
    { label: "VStack", node: VStackStory({}) },
    { label: "HStack", node: HStackStory({}) },
    { label: "VGroup", node: VGroupStory({}) },
    { label: "HGroup", node: HGroupStory({}) },
    { label: "VScroll", node: VScrollStory({}) },
    { label: "HScroll", node: HScrollStory({}) },
    { label: "Textarea", node: TextareaStory({}) },
    { label: "Message Input", node: MessageInputStory({}) },
    { label: "Toolbar", node: ToolbarStory({}) },
    { label: "Heading", node: HeadingStory({}) },
    { label: "Label", node: LabelStory({}) },
    { label: "Chip", node: ChipStory({}) },
    { label: "Badge", node: BadgeStory({}) },
    { label: "Alert", node: AlertStory({}) },
    { label: "Separator", node: SeparatorStory({}) },
    { label: "Markdown", node: MarkdownStory({}) },
    { label: "Loader", node: LoaderStory({}) },
    { label: "Skeleton", node: SkeletonStory({}) },
    { label: "Collapsible", node: CollapsibleStory({}) },
    { label: "Tabs", node: TabsStory({}) },
    { label: "Chart", node: ChartStory({}) },
  ];

  return {
    [NAME]: "Kitchen Sink Story",
    [UI]: (
      <div style={{ padding: "1rem 1rem 4rem" }}>
        <div
          style={{
            marginBottom: "1rem",
            color: "#334155",
            fontSize: "14px",
          }}
        >
          All catalog component stories in one place.
        </div>
        {sections.map((section) => (
          <div
            style={{
              marginBottom: "1.5rem",
              border: "1px solid #e2e8f0",
              borderRadius: "8px",
              overflow: "hidden",
              backgroundColor: "#ffffff",
            }}
          >
            <div
              style={{
                padding: "10px 12px",
                borderBottom: "1px solid #e2e8f0",
                fontSize: "12px",
                fontWeight: "700",
                color: "#475569",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                backgroundColor: "#f8fafc",
              }}
            >
              {section.label}
            </div>
            <div style={{ padding: "12px" }}>{section.node}</div>
          </div>
        ))}
      </div>
    ),
  };
});
