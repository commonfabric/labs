import { NAME, pattern, UI, type VNode, Writable } from "commonfabric";

// deno-lint-ignore no-empty-interface
interface TabsStoryInput {}
export interface TabsStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<TabsStoryInput, TabsStoryOutput>(() => {
  const activeTab = new Writable("one");

  return {
    [NAME]: "cf-tabs Story",
    [UI]: (
      <div
        style={{
          padding: "1rem",
          maxWidth: "400px",
        }}
      >
        <cf-tabs $value={activeTab}>
          <cf-tab-list>
            <cf-tab value="one">Tab One</cf-tab>
            <cf-tab value="two">Tab Two</cf-tab>
            <cf-tab value="three" disabled>Disabled</cf-tab>
          </cf-tab-list>
          <cf-tab-panel value="one">
            <div style="padding: 16px; font-size: 13px; color: #666;">
              Content for Tab One. Keyboard navigable with arrow keys.
            </div>
          </cf-tab-panel>
          <cf-tab-panel value="two">
            <div style="padding: 16px; font-size: 13px; color: #666;">
              Content for Tab Two.
            </div>
          </cf-tab-panel>
          <cf-tab-panel value="three">
            <div style="padding: 16px; font-size: 13px; color: #666;">
              Content for disabled tab (not reachable).
            </div>
          </cf-tab-panel>
        </cf-tabs>
      </div>
    ),
    controls: (
      <div style={{ color: "#6b7280", fontSize: "13px", padding: "8px 12px" }}>
        No interactive controls. Composed of cf-tabs, cf-tab-list, cf-tab, and
        cf-tab-panel.
      </div>
    ),
  };
});
