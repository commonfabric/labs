/**
 * Test Pattern: component catalog stories (second half)
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
 * The other half of the stories is covered by catalog-stories-1.test.tsx;
 * cf-calendar and cf-submit-input have test files of their own.
 */
import { assert, NAME, pattern, TESTS, UI } from "commonfabric";

import ProgressStory from "./cf-progress-story.tsx";
import RadioStory from "./cf-radio-story.tsx";
import RenderStory from "./cf-render-story.tsx";
import SelectStory from "./cf-select-story.tsx";
import SeparatorStory from "./cf-separator-story.tsx";
import SkeletonStory from "./cf-skeleton-story.tsx";
import SliderStory from "./cf-slider-story.tsx";
import SvgStory from "./cf-svg-story.tsx";
import SwitchStory from "./cf-switch-story.tsx";
import TabBarStory from "./cf-tab-bar-story.tsx";
import TabListStory from "./cf-tab-list-story.tsx";
import TableStory from "./cf-table-story.tsx";
import TabsStory from "./cf-tabs-story.tsx";
import TagsStory from "./cf-tags-story.tsx";
import TextStory from "./cf-text-story.tsx";
import TextareaStory from "./cf-textarea-story.tsx";
import ToastStory from "./cf-toast-story.tsx";
import ToggleGroupStory from "./cf-toggle-group-story.tsx";
import ToggleStory from "./cf-toggle-story.tsx";
import ToolbarStory from "./cf-toolbar-story.tsx";
import VgroupStory from "./cf-vgroup-story.tsx";
import VscrollStory from "./cf-vscroll-story.tsx";
import VstackStory from "./cf-vstack-story.tsx";
import KitchenSinkStory from "./kitchen-sink-story.tsx";
import NoteStory from "./note-story.tsx";
import StyleTokensStory from "./style-tokens-story.tsx";
import ThemeSamplerStory from "./theme-sampler-story.tsx";
import VignetteFinanceStory from "./vignette-finance-story.tsx";
import VignetteMobileAppStory from "./vignette-mobile-app-story.tsx";
import VignetteRecipeStory from "./vignette-recipe-story.tsx";

export default pattern(() => {
  const progressStory = ProgressStory({});
  const radioStory = RadioStory({});
  const renderStory = RenderStory({});
  const selectStory = SelectStory({});
  const separatorStory = SeparatorStory({});
  const skeletonStory = SkeletonStory({});
  const sliderStory = SliderStory({});
  const svgStory = SvgStory({});
  const switchStory = SwitchStory({});
  const tabBarStory = TabBarStory({});
  const tabListStory = TabListStory({});
  const tableStory = TableStory({});
  const tabsStory = TabsStory({});
  const tagsStory = TagsStory({});
  const textStory = TextStory({});
  const textareaStory = TextareaStory({});
  const toastStory = ToastStory({});
  const toggleGroupStory = ToggleGroupStory({});
  const toggleStory = ToggleStory({});
  const toolbarStory = ToolbarStory({});
  const vgroupStory = VgroupStory({});
  const vscrollStory = VscrollStory({});
  const vstackStory = VstackStory({});
  const kitchenSinkStory = KitchenSinkStory({});
  const noteStory = NoteStory({});
  const styleTokensStory = StyleTokensStory({});
  const themeSamplerStory = ThemeSamplerStory({});
  const vignetteFinanceStory = VignetteFinanceStory({});
  const vignetteMobileAppStory = VignetteMobileAppStory({});
  const vignetteRecipeStory = VignetteRecipeStory({});

  const assert_cf_progress_story = assert(() =>
    progressStory[NAME] === "cf-progress Story" && progressStory[UI] != null
  );
  const assert_cf_radio_story = assert(() =>
    radioStory[NAME] === "cf-radio Story" && radioStory[UI] != null
  );
  const assert_cf_render_story = assert(() =>
    renderStory[NAME] === "cf-render Story" && renderStory[UI] != null
  );
  const assert_cf_select_story = assert(() =>
    selectStory[NAME] === "cf-select Story" && selectStory[UI] != null
  );
  const assert_cf_separator_story = assert(() =>
    separatorStory[NAME] === "cf-separator Story" && separatorStory[UI] != null
  );
  const assert_cf_skeleton_story = assert(() =>
    skeletonStory[NAME] === "cf-skeleton Story" && skeletonStory[UI] != null
  );
  const assert_cf_slider_story = assert(() =>
    sliderStory[NAME] === "cf-slider Story" && sliderStory[UI] != null
  );
  const assert_cf_svg_story = assert(() =>
    svgStory[NAME] === "cf-svg Story" && svgStory[UI] != null
  );
  const assert_cf_switch_story = assert(() =>
    switchStory[NAME] === "cf-switch Story" && switchStory[UI] != null
  );
  const assert_cf_tab_bar_story = assert(() =>
    tabBarStory[NAME] === "cf-tab-bar Story" && tabBarStory[UI] != null
  );
  const assert_cf_tab_list_story = assert(() =>
    tabListStory[NAME] === "cf-tab-list Story" && tabListStory[UI] != null
  );
  const assert_cf_table_story = assert(() =>
    tableStory[NAME] === "cf-table Story" && tableStory[UI] != null
  );
  const assert_cf_tabs_story = assert(() =>
    tabsStory[NAME] === "cf-tabs Story" && tabsStory[UI] != null
  );
  const assert_cf_tags_story = assert(() =>
    tagsStory[NAME] === "cf-tags Story" && tagsStory[UI] != null
  );
  const assert_cf_text_story = assert(() =>
    textStory[NAME] === "cf-text Story" && textStory[UI] != null
  );
  const assert_cf_textarea_story = assert(() =>
    textareaStory[NAME] === "cf-textarea Story" && textareaStory[UI] != null
  );
  const assert_cf_toast_story = assert(() =>
    toastStory[NAME] === "cf-toast Story" && toastStory[UI] != null
  );
  const assert_cf_toggle_group_story = assert(() =>
    toggleGroupStory[NAME] === "cf-toggle-group Story" &&
    toggleGroupStory[UI] != null
  );
  const assert_cf_toggle_story = assert(() =>
    toggleStory[NAME] === "cf-toggle Story" && toggleStory[UI] != null
  );
  const assert_cf_toolbar_story = assert(() =>
    toolbarStory[NAME] === "cf-toolbar Story" && toolbarStory[UI] != null
  );
  const assert_cf_vgroup_story = assert(() =>
    vgroupStory[NAME] === "cf-vgroup Story" && vgroupStory[UI] != null
  );
  const assert_cf_vscroll_story = assert(() =>
    vscrollStory[NAME] === "cf-vscroll Story" && vscrollStory[UI] != null
  );
  const assert_cf_vstack_story = assert(() =>
    vstackStory[NAME] === "cf-vstack Story" && vstackStory[UI] != null
  );
  const assert_kitchen_sink_story = assert(() =>
    kitchenSinkStory[NAME] === "Kitchen Sink Story" &&
    kitchenSinkStory[UI] != null
  );
  const assert_note_story = assert(() =>
    noteStory[NAME] === "Note Story" && noteStory[UI] != null
  );
  const assert_style_tokens_story = assert(() =>
    styleTokensStory[NAME] === "Style Tokens" && styleTokensStory[UI] != null
  );
  const assert_theme_sampler_story = assert(() =>
    themeSamplerStory[NAME] === "Theme Sampler" && themeSamplerStory[UI] != null
  );
  const assert_vignette_finance_story = assert(() =>
    vignetteFinanceStory[NAME] === "Vignette: Finance Dashboard" &&
    vignetteFinanceStory[UI] != null
  );
  const assert_vignette_mobile_app_story = assert(() =>
    vignetteMobileAppStory[NAME] === "Vignette: Mobile App" &&
    vignetteMobileAppStory[UI] != null
  );
  const assert_vignette_recipe_story = assert(() =>
    vignetteRecipeStory[NAME] === "Vignette: Recipe App" &&
    vignetteRecipeStory[UI] != null
  );

  return {
    [TESTS]: [
      { assertion: assert_cf_progress_story },
      { assertion: assert_cf_radio_story },
      { assertion: assert_cf_render_story },
      { assertion: assert_cf_select_story },
      { assertion: assert_cf_separator_story },
      { assertion: assert_cf_skeleton_story },
      { assertion: assert_cf_slider_story },
      { assertion: assert_cf_svg_story },
      { assertion: assert_cf_switch_story },
      { assertion: assert_cf_tab_bar_story },
      { assertion: assert_cf_tab_list_story },
      { assertion: assert_cf_table_story },
      { assertion: assert_cf_tabs_story },
      { assertion: assert_cf_tags_story },
      { assertion: assert_cf_text_story },
      { assertion: assert_cf_textarea_story },
      { assertion: assert_cf_toast_story },
      { assertion: assert_cf_toggle_group_story },
      { assertion: assert_cf_toggle_story },
      { assertion: assert_cf_toolbar_story },
      { assertion: assert_cf_vgroup_story },
      { assertion: assert_cf_vscroll_story },
      { assertion: assert_cf_vstack_story },
      { assertion: assert_kitchen_sink_story },
      { assertion: assert_note_story },
      { assertion: assert_style_tokens_story },
      { assertion: assert_theme_sampler_story },
      { assertion: assert_vignette_finance_story },
      { assertion: assert_vignette_mobile_app_story },
      { assertion: assert_vignette_recipe_story },
    ],
  };
});
