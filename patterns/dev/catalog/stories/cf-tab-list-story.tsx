import { NAME, pattern, UI, type VNode, Writable } from "commonfabric";

import { Controls, SelectControl } from "../ui/controls/index.ts";

// deno-lint-ignore no-empty-interface
interface TabListStoryInput {}
export interface TabListStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<TabListStoryInput, TabListStoryOutput>(() => {
  const orientation = new Writable<"horizontal" | "vertical">("horizontal");
  const variant = new Writable<"underline" | "chip">("underline");
  const activeTab = new Writable("overview");
  const activeChipTab = new Writable("all");

  return {
    [NAME]: "cf-tab-list Story",
    [UI]: (
      <div style={{ padding: "1rem", maxWidth: "520px" }}>
        <cf-tabs $value={activeTab} orientation={orientation}>
          <cf-tab-list orientation={orientation} variant={variant}>
            <cf-tab value="overview">Overview</cf-tab>
            <cf-tab value="settings">Settings</cf-tab>
            <cf-tab value="activity">Activity</cf-tab>
          </cf-tab-list>
          <cf-tab-panel value="overview">
            <div style="padding: 12px; font-size: 13px; color: #475569;">
              Overview content
            </div>
          </cf-tab-panel>
          <cf-tab-panel value="settings">
            <div style="padding: 12px; font-size: 13px; color: #475569;">
              Settings content
            </div>
          </cf-tab-panel>
          <cf-tab-panel value="activity">
            <div style="padding: 12px; font-size: 13px; color: #475569;">
              Activity content
            </div>
          </cf-tab-panel>
        </cf-tabs>

        <div style={{ marginTop: "2rem" }}>
          <div style="font-size: 13px; font-weight: 600; color: #374151; margin-bottom: 8px;">
            Chip variant with overflow scrolling
          </div>
          <div
            style={{
              maxWidth: "320px",
              border: "1px dashed #d1d5db",
              borderRadius: "8px",
              padding: "8px",
            }}
          >
            <cf-tabs $value={activeChipTab}>
              <cf-tab-list variant="chip">
                <cf-tab value="all">All</cf-tab>
                <cf-tab value="notes">Notes</cf-tab>
                <cf-tab value="bookmarks">Bookmarks</cf-tab>
                <cf-tab value="highlights">Highlights</cf-tab>
                <cf-tab value="summaries">Summaries</cf-tab>
                <cf-tab value="drafts">Drafts</cf-tab>
                <cf-tab value="archived">Archived</cf-tab>
              </cf-tab-list>
            </cf-tabs>
          </div>
        </div>

        <div style={{ marginTop: "2rem" }}>
          <div style="font-size: 13px; font-weight: 600; color: #374151; margin-bottom: 8px;">
            Narrow mobile header overflow
          </div>
          <div
            style={{
              maxWidth: "280px",
              border: "1px dashed #d1d5db",
              borderRadius: "8px",
              padding: "8px",
            }}
          >
            <cf-hstack align="center" gap="2" style="width: 100%;">
              <cf-button variant="ghost" size="icon">×</cf-button>
              <cf-tabs
                $value={activeChipTab}
                style="--cf-tabs-width: auto; min-width: 0; flex: 1;"
              >
                <cf-tab-list variant="chip">
                  <cf-tab value="all">All</cf-tab>
                  <cf-tab value="notes">Notes</cf-tab>
                  <cf-tab value="bookmarks">Bookmarks</cf-tab>
                  <cf-tab value="highlights">Highlights</cf-tab>
                  <cf-tab value="summaries">Summaries</cf-tab>
                  <cf-tab value="drafts">Drafts</cf-tab>
                  <cf-tab value="archived">Archived</cf-tab>
                </cf-tab-list>
              </cf-tabs>
              <cf-button variant="ghost" size="icon">+</cf-button>
              <cf-button variant="solid" color="primary" size="icon">
                ✓
              </cf-button>
            </cf-hstack>
          </div>
        </div>
      </div>
    ),
    controls: (
      <Controls>
        <>
          <SelectControl
            label="orientation"
            description="Direction for tab-list layout"
            defaultValue="horizontal"
            value={orientation as any}
            items={[
              { label: "horizontal", value: "horizontal" },
              { label: "vertical", value: "vertical" },
            ]}
          />
          <SelectControl
            label="variant"
            description="Visual style: underline (default) or chip (pill)"
            defaultValue="underline"
            value={variant as any}
            items={[
              { label: "underline", value: "underline" },
              { label: "chip", value: "chip" },
            ]}
          />
        </>
      </Controls>
    ),
  };
});
