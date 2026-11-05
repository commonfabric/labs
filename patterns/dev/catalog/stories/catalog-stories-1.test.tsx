/**
 * Test Pattern: component catalog stories (first half)
 *
 * A story is the catalog's live example of one component. It builds the
 * component with some state behind it, a panel of controls for changing that
 * state, and the name the catalog lists it under. Instantiating a story runs
 * the JSX for the example and for the controls, so a story that stopped
 * building either one fails here rather than rendering blank in the catalog.
 *
 * Each story gets its own assertion, so a failure names the story rather than
 * a chain of every story in the file. The assertion reads the name and the
 * rendered example. It leaves `controls` alone: that value is a composed
 * fragment of control components, which does not resolve to a plain non-null
 * inside an assertion, and instantiation has already run its JSX.
 *
 * The other half of the stories is covered by catalog-stories-2.test.tsx;
 * cf-calendar and cf-submit-input have test files of their own.
 */
import { assert, NAME, pattern, TESTS, UI } from "commonfabric";

import AlertStory from "./cf-alert-story.tsx";
import AutocompleteStory from "./cf-autocomplete-story.tsx";
import AvatarStory from "./cf-avatar-story.tsx";
import BadgeStory from "./cf-badge-story.tsx";
import ButtonStory from "./cf-button-story.tsx";
import CardStory from "./cf-card-story.tsx";
import ChartStory from "./cf-chart-story.tsx";
import ChatStory from "./cf-chat-story.tsx";
import CheckboxStory from "./cf-checkbox-story.tsx";
import ChipStory from "./cf-chip-story.tsx";
import CodeEditorStory from "./cf-code-editor-story.tsx";
import CollapsibleStory from "./cf-collapsible-story.tsx";
import CopyButtonStory from "./cf-copy-button-story.tsx";
import EmptyStateStory from "./cf-empty-state-story.tsx";
import FieldStory from "./cf-field-story.tsx";
import GridStory from "./cf-grid-story.tsx";
import HeadingStory from "./cf-heading-story.tsx";
import HgroupStory from "./cf-hgroup-story.tsx";
import HoverCardStory from "./cf-hover-card-story.tsx";
import HoverRevealStory from "./cf-hover-reveal-story.tsx";
import HscrollStory from "./cf-hscroll-story.tsx";
import HstackStory from "./cf-hstack-story.tsx";
import InputStory from "./cf-input-story.tsx";
import KbdStory from "./cf-kbd-story.tsx";
import LabelStory from "./cf-label-story.tsx";
import ListItemStory from "./cf-list-item-story.tsx";
import LoaderStory from "./cf-loader-story.tsx";
import MarkdownStory from "./cf-markdown-story.tsx";
import MessageInputStory from "./cf-message-input-story.tsx";
import ModalStory from "./cf-modal-story.tsx";
import PickerStory from "./cf-picker-story.tsx";
import ProfileBadgeStory from "./cf-profile-badge-story.tsx";

export default pattern(() => {
  const alertStory = AlertStory({});
  const autocompleteStory = AutocompleteStory({});
  const avatarStory = AvatarStory({});
  const badgeStory = BadgeStory({});
  const buttonStory = ButtonStory({});
  const cardStory = CardStory({});
  const chartStory = ChartStory({});
  const chatStory = ChatStory({});
  const checkboxStory = CheckboxStory({});
  const chipStory = ChipStory({});
  const codeEditorStory = CodeEditorStory({});
  const collapsibleStory = CollapsibleStory({});
  const copyButtonStory = CopyButtonStory({});
  const emptyStateStory = EmptyStateStory({});
  const fieldStory = FieldStory({});
  const gridStory = GridStory({});
  const headingStory = HeadingStory({});
  const hgroupStory = HgroupStory({});
  const hoverCardStory = HoverCardStory({});
  const hoverRevealStory = HoverRevealStory({});
  const hscrollStory = HscrollStory({});
  const hstackStory = HstackStory({});
  const inputStory = InputStory({});
  const kbdStory = KbdStory({});
  const labelStory = LabelStory({});
  const listItemStory = ListItemStory({});
  const loaderStory = LoaderStory({});
  const markdownStory = MarkdownStory({});
  const messageInputStory = MessageInputStory({});
  const modalStory = ModalStory({});
  const pickerStory = PickerStory({});
  const profileBadgeStory = ProfileBadgeStory({});

  const assert_cf_alert_story = assert(() =>
    alertStory[NAME] === "cf-alert Story" && alertStory[UI] != null
  );
  const assert_cf_autocomplete_story = assert(() =>
    autocompleteStory[NAME] === "cf-autocomplete Story" &&
    autocompleteStory[UI] != null
  );
  const assert_cf_avatar_story = assert(() =>
    avatarStory[NAME] === "cf-avatar Story" && avatarStory[UI] != null
  );
  const assert_cf_badge_story = assert(() =>
    badgeStory[NAME] === "cf-badge Story" && badgeStory[UI] != null
  );
  const assert_cf_button_story = assert(() =>
    buttonStory[NAME] === "cf-button Story" && buttonStory[UI] != null
  );
  const assert_cf_card_story = assert(() =>
    cardStory[NAME] === "cf-card Story" && cardStory[UI] != null
  );
  const assert_cf_chart_story = assert(() =>
    chartStory[NAME] === "cf-chart Story" && chartStory[UI] != null
  );
  const assert_cf_chat_story = assert(() =>
    chatStory[NAME] === "cf-chat Story" && chatStory[UI] != null
  );
  const assert_cf_checkbox_story = assert(() =>
    checkboxStory[NAME] === "cf-checkbox Story" && checkboxStory[UI] != null
  );
  const assert_cf_chip_story = assert(() =>
    chipStory[NAME] === "cf-chip Story" && chipStory[UI] != null
  );
  const assert_cf_code_editor_story = assert(() =>
    codeEditorStory[NAME] === "cf-code-editor Story" &&
    codeEditorStory[UI] != null
  );
  const assert_cf_collapsible_story = assert(() =>
    collapsibleStory[NAME] === "cf-collapsible Story" &&
    collapsibleStory[UI] != null
  );
  const assert_cf_copy_button_story = assert(() =>
    copyButtonStory[NAME] === "cf-copy-button Story" &&
    copyButtonStory[UI] != null
  );
  const assert_cf_empty_state_story = assert(() =>
    emptyStateStory[NAME] === "cf-empty-state Story" &&
    emptyStateStory[UI] != null
  );
  const assert_cf_field_story = assert(() =>
    fieldStory[NAME] === "cf-field Story" && fieldStory[UI] != null
  );
  const assert_cf_grid_story = assert(() =>
    gridStory[NAME] === "cf-grid Story" && gridStory[UI] != null
  );
  const assert_cf_heading_story = assert(() =>
    headingStory[NAME] === "cf-heading Story" && headingStory[UI] != null
  );
  const assert_cf_hgroup_story = assert(() =>
    hgroupStory[NAME] === "cf-hgroup Story" && hgroupStory[UI] != null
  );
  const assert_cf_hover_card_story = assert(() =>
    hoverCardStory[NAME] === "cf-hover-card Story" &&
    hoverCardStory[UI] != null
  );
  const assert_cf_hover_reveal_story = assert(() =>
    hoverRevealStory[NAME] === "cf-hover-reveal Story" &&
    hoverRevealStory[UI] != null
  );
  const assert_cf_hscroll_story = assert(() =>
    hscrollStory[NAME] === "cf-hscroll Story" && hscrollStory[UI] != null
  );
  const assert_cf_hstack_story = assert(() =>
    hstackStory[NAME] === "cf-hstack Story" && hstackStory[UI] != null
  );
  const assert_cf_input_story = assert(() =>
    inputStory[NAME] === "cf-input Story" && inputStory[UI] != null
  );
  const assert_cf_kbd_story = assert(() =>
    kbdStory[NAME] === "cf-kbd Story" && kbdStory[UI] != null
  );
  const assert_cf_label_story = assert(() =>
    labelStory[NAME] === "cf-label Story" && labelStory[UI] != null
  );
  const assert_cf_list_item_story = assert(() =>
    listItemStory[NAME] === "cf-list-item Story" && listItemStory[UI] != null
  );
  const assert_cf_loader_story = assert(() =>
    loaderStory[NAME] === "cf-loader Story" && loaderStory[UI] != null
  );
  const assert_cf_markdown_story = assert(() =>
    markdownStory[NAME] === "cf-markdown Story" && markdownStory[UI] != null
  );
  const assert_cf_message_input_story = assert(() =>
    messageInputStory[NAME] === "cf-message-input Story" &&
    messageInputStory[UI] != null
  );
  const assert_cf_modal_story = assert(() =>
    modalStory[NAME] === "cf-modal Story" && modalStory[UI] != null
  );
  const assert_cf_picker_story = assert(() =>
    pickerStory[NAME] === "cf-picker Story" && pickerStory[UI] != null
  );
  const assert_cf_profile_badge_story = assert(() =>
    profileBadgeStory[NAME] === "cf-profile-badge Story" &&
    profileBadgeStory[UI] != null
  );

  return {
    [TESTS]: [
      { assertion: assert_cf_alert_story },
      { assertion: assert_cf_autocomplete_story },
      { assertion: assert_cf_avatar_story },
      { assertion: assert_cf_badge_story },
      { assertion: assert_cf_button_story },
      { assertion: assert_cf_card_story },
      { assertion: assert_cf_chart_story },
      { assertion: assert_cf_chat_story },
      { assertion: assert_cf_checkbox_story },
      { assertion: assert_cf_chip_story },
      { assertion: assert_cf_code_editor_story },
      { assertion: assert_cf_collapsible_story },
      { assertion: assert_cf_copy_button_story },
      { assertion: assert_cf_empty_state_story },
      { assertion: assert_cf_field_story },
      { assertion: assert_cf_grid_story },
      { assertion: assert_cf_heading_story },
      { assertion: assert_cf_hgroup_story },
      { assertion: assert_cf_hover_card_story },
      { assertion: assert_cf_hover_reveal_story },
      { assertion: assert_cf_hscroll_story },
      { assertion: assert_cf_hstack_story },
      { assertion: assert_cf_input_story },
      { assertion: assert_cf_kbd_story },
      { assertion: assert_cf_label_story },
      { assertion: assert_cf_list_item_story },
      { assertion: assert_cf_loader_story },
      { assertion: assert_cf_markdown_story },
      { assertion: assert_cf_message_input_story },
      { assertion: assert_cf_modal_story },
      { assertion: assert_cf_picker_story },
      { assertion: assert_cf_profile_badge_story },
    ],
  };
});
