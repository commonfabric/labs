import { computed, NAME, pattern, UI, type VNode } from "commonfabric";

import ButtonStory from "../stories/cf-button-story.tsx";
import CheckboxStory from "../stories/cf-checkbox-story.tsx";
import CodeEditorStory from "../stories/cf-code-editor-story.tsx";
import InputStory from "../stories/cf-input-story.tsx";
import PickerStory from "../stories/cf-picker-story.tsx";
import SelectStory from "../stories/cf-select-story.tsx";
import SliderStory from "../stories/cf-slider-story.tsx";
import SwitchStory from "../stories/cf-switch-story.tsx";
import ToggleStory from "../stories/cf-toggle-story.tsx";
import ToggleGroupStory from "../stories/cf-toggle-group-story.tsx";
import CardStory from "../stories/cf-card-story.tsx";
import ListItemStory from "../stories/cf-list-item-story.tsx";
import ModalStory from "../stories/cf-modal-story.tsx";
import ProgressStory from "../stories/cf-progress-story.tsx";
import VStackStory from "../stories/cf-vstack-story.tsx";
import HStackStory from "../stories/cf-hstack-story.tsx";
import VGroupStory from "../stories/cf-vgroup-story.tsx";
import HGroupStory from "../stories/cf-hgroup-story.tsx";
import HoverCardStory from "../stories/cf-hover-card-story.tsx";
import HoverRevealStory from "../stories/cf-hover-reveal-story.tsx";
import VScrollStory from "../stories/cf-vscroll-story.tsx";
import HScrollStory from "../stories/cf-hscroll-story.tsx";
import TextareaStory from "../stories/cf-textarea-story.tsx";
import MessageInputStory from "../stories/cf-message-input-story.tsx";
import SubmitInputStory from "../stories/cf-submit-input-story.tsx";
import ToolbarStory from "../stories/cf-toolbar-story.tsx";
import HeadingStory from "../stories/cf-heading-story.tsx";
import TextStory from "../stories/cf-text-story.tsx";
import LabelStory from "../stories/cf-label-story.tsx";
import FieldStory from "../stories/cf-field-story.tsx";
import ChipStory from "../stories/cf-chip-story.tsx";
import BadgeStory from "../stories/cf-badge-story.tsx";
import EmptyStateStory from "../stories/cf-empty-state-story.tsx";
import AvatarStory from "../stories/cf-avatar-story.tsx";
import ProfileBadgeStory from "../stories/cf-profile-badge-story.tsx";
import AlertStory from "../stories/cf-alert-story.tsx";
import SeparatorStory from "../stories/cf-separator-story.tsx";
import MarkdownStory from "../stories/cf-markdown-story.tsx";
import SvgStory from "../stories/cf-svg-story.tsx";
import LoaderStory from "../stories/cf-loader-story.tsx";
import SkeletonStory from "../stories/cf-skeleton-story.tsx";
import CollapsibleStory from "../stories/cf-collapsible-story.tsx";
import TabListStory from "../stories/cf-tab-list-story.tsx";
import TabBarStory from "../stories/cf-tab-bar-story.tsx";
import TabsStory from "../stories/cf-tabs-story.tsx";
import ChartStory from "../stories/cf-chart-story.tsx";
import NoteStory from "../stories/note-story.tsx";
import RenderStory from "../stories/cf-render-story.tsx";
import KitchenSinkStory from "../stories/kitchen-sink-story.tsx";
import ChatStory from "../stories/cf-chat-story.tsx";
import CalendarStory from "../stories/cf-calendar-story.tsx";
import RadioStory from "../stories/cf-radio-story.tsx";
import AutocompleteStory from "../stories/cf-autocomplete-story.tsx";
import TableStory from "../stories/cf-table-story.tsx";
import KbdStory from "../stories/cf-kbd-story.tsx";
import CopyButtonStory from "../stories/cf-copy-button-story.tsx";
import TagsStory from "../stories/cf-tags-story.tsx";
import GridStory from "../stories/cf-grid-story.tsx";
import VignetteRecipeStory from "../stories/vignette-recipe-story.tsx";
import VignetteFinanceStory from "../stories/vignette-finance-story.tsx";
import VignetteMobileAppStory from "../stories/vignette-mobile-app-story.tsx";
import ToastStory from "../stories/cf-toast-story.tsx";
import StyleTokensStory from "../stories/style-tokens-story.tsx";
import ThemeSamplerStory from "../stories/theme-sampler-story.tsx";

interface StoryRendererInput {
  selected: string;
}

export interface StoryRendererOutput {
  [NAME]: string;
  [UI]: VNode;
  controls?: VNode;
}

type CatalogStory = {
  [NAME]: string;
  [UI]: VNode;
  controls?: VNode;
} | null;

type StoryFactory = (input: Record<string, never>) => CatalogStory;

/** Every story the catalog can show, by the id its sidebar lists it under. */
function storyTable(): Record<string, StoryFactory> {
  return {
    button: ButtonStory,
    checkbox: CheckboxStory,
    "code-editor": CodeEditorStory,
    input: InputStory,
    picker: PickerStory,
    select: SelectStory,
    slider: SliderStory,
    switch: SwitchStory,
    toggle: ToggleStory,
    "toggle-group": ToggleGroupStory,
    card: CardStory,
    "list-item": ListItemStory,
    modal: ModalStory,
    progress: ProgressStory,
    vstack: VStackStory,
    hstack: HStackStory,
    vgroup: VGroupStory,
    hgroup: HGroupStory,
    "hover-card": HoverCardStory,
    "hover-reveal": HoverRevealStory,
    vscroll: VScrollStory,
    hscroll: HScrollStory,
    textarea: TextareaStory,
    "message-input": MessageInputStory,
    "submit-input": SubmitInputStory,
    toolbar: ToolbarStory,
    heading: HeadingStory,
    text: TextStory,
    label: LabelStory,
    field: FieldStory,
    chip: ChipStory,
    badge: BadgeStory,
    "empty-state": EmptyStateStory,
    avatar: AvatarStory,
    "profile-badge": ProfileBadgeStory,
    alert: AlertStory,
    separator: SeparatorStory,
    markdown: MarkdownStory,
    svg: SvgStory,
    loader: LoaderStory,
    skeleton: SkeletonStory,
    collapsible: CollapsibleStory,
    "tab-list": TabListStory,
    "tab-bar": TabBarStory,
    tabs: TabsStory,
    chart: ChartStory,
    note: NoteStory,
    render: RenderStory,
    "kitchen-sink": KitchenSinkStory,
    chat: ChatStory,
    calendar: CalendarStory,
    radio: RadioStory,
    autocomplete: AutocompleteStory,
    table: TableStory,
    kbd: KbdStory,
    "copy-button": CopyButtonStory,
    tags: TagsStory,
    grid: GridStory,
    "vignette-recipe": VignetteRecipeStory,
    "vignette-finance": VignetteFinanceStory,
    "vignette-mobile-app": VignetteMobileAppStory,
    toast: ToastStory,
    "style-tokens": StyleTokensStory,
    "theme-sampler": ThemeSamplerStory,
  };
}

/** The ids of every story the catalog can show. */
export function storyIds(): string[] {
  return Object.keys(storyTable());
}

export default pattern<StoryRendererInput, StoryRendererOutput>(
  ({ selected }) => {
    // A pattern made inside a computed is named after the computed and the
    // call's place in the run, which is the same whichever story is picked, so
    // each story is named after its id instead: otherwise every story would
    // share one result and one set of cells. The factory's return type does not
    // offer `.for()`, hence the cast.
    const story = computed<CatalogStory>(() => {
      const stories = storyTable();
      return Object.hasOwn(stories, selected)
        // deno-lint-ignore no-explicit-any
        ? (stories[selected]({}) as any).for(selected)
        : null;
    });

    return {
      [NAME]: "StoryRenderer",
      [UI]: <>{story}</>,
      controls: story?.controls,
    };
  },
);
