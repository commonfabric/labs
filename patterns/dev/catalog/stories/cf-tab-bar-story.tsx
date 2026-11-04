import { NAME, pattern, UI, type VNode, Writable } from "commonfabric";

// deno-lint-ignore no-empty-interface
interface TabBarStoryInput {}
export interface TabBarStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<TabBarStoryInput, TabBarStoryOutput>(() => {
  const activeTab1 = new Writable("home");
  const activeTab2 = new Writable("home");
  const activeTab3 = new Writable("home");
  const activeTab4 = new Writable("home");

  const items = (
    <>
      <cf-tab-bar-item value="home" label="Home">
        <span slot="icon">&#127968;</span>
      </cf-tab-bar-item>
      <cf-tab-bar-item value="explore" label="Explore">
        <span slot="icon">&#128269;</span>
      </cf-tab-bar-item>
      <cf-tab-bar-item value="inbox" label="Inbox">
        <span slot="icon">&#128236;</span>
      </cf-tab-bar-item>
      <cf-tab-bar-item value="profile" label="Profile">
        <span slot="icon">&#128100;</span>
      </cf-tab-bar-item>
    </>
  );

  return {
    [NAME]: "cf-tab-bar Story",
    [UI]: (
      <cf-vstack gap="6" style="padding: 1rem;">
        <cf-vstack gap="2">
          <cf-heading level={5}>Default variant</cf-heading>
          <span style="font-size: 13px; color: #6b7280;">
            Full-width bar with top border, anchored to edge.
          </span>
          <div
            style={{
              position: "relative",
              height: "120px",
              background: "#f0f4f8",
              borderRadius: "8px",
              overflow: "hidden",
            }}
          >
            <cf-tab-bar
              $value={activeTab1}
              variant="default"
              style="position: absolute;"
            >
              {items}
            </cf-tab-bar>
          </div>
        </cf-vstack>

        <cf-vstack gap="2">
          <cf-heading level={5}>Inset variant</cf-heading>
          <span style="font-size: 13px; color: #6b7280;">
            Floating pill, content-sized, centered.
          </span>
          <div
            style={{
              position: "relative",
              height: "120px",
              background: "#f0f4f8",
              borderRadius: "8px",
              overflow: "hidden",
            }}
          >
            <cf-tab-bar
              $value={activeTab2}
              variant="inset"
              style="position: absolute;"
            >
              {items}
            </cf-tab-bar>
          </div>
        </cf-vstack>

        <cf-vstack gap="2">
          <cf-heading level={5}>Inset variant with action (FAB)</cf-heading>
          <span style="font-size: 13px; color: #6b7280;">
            Floating pill with primary action button beside it.
          </span>
          <div
            style={{
              position: "relative",
              height: "120px",
              background: "#f0f4f8",
              borderRadius: "8px",
              overflow: "hidden",
            }}
          >
            <cf-tab-bar
              $value={activeTab3}
              variant="inset"
              style="position: absolute;"
            >
              {items}
              <cf-button
                slot="action"
                variant="primary"
                style="border-radius: var(--cf-border-radius-xl, 0.75rem); width: 3.5rem; height: 100%; padding: 0; flex-shrink: 0;"
              >
                &#65291;
              </cf-button>
            </cf-tab-bar>
          </div>
        </cf-vstack>

        <cf-vstack gap="2">
          <cf-heading level={5}>Inset footer in cf-screen</cf-heading>
          <span style="font-size: 13px; color: #6b7280;">
            The screen footer reserves room for the floating tab bar.
          </span>
          <div
            style={{
              height: "360px",
              background: "#f0f4f8",
              border: "1px solid #dbe3ec",
              borderRadius: "8px",
              overflow: "hidden",
            }}
          >
            <cf-screen style="height: 100%;">
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "10px",
                  padding: "12px",
                }}
              >
                {[
                  "Morning sync",
                  "Review launch checklist",
                  "Triage customer thread",
                  "Write design notes",
                  "Confirm footer spacing",
                  "Last visible card",
                ].map((title) => (
                  <cf-card>
                    <cf-vstack gap="1">
                      <cf-text variant="body-compact">{title}</cf-text>
                      <cf-text variant="caption" tone="muted">
                        Content remains above the reserved footer area.
                      </cf-text>
                    </cf-vstack>
                  </cf-card>
                ))}
              </div>

              <cf-tab-bar
                $value={activeTab4}
                slot="footer"
                variant="inset"
              >
                {items}
              </cf-tab-bar>
            </cf-screen>
          </div>
        </cf-vstack>
      </cf-vstack>
    ),
    controls: <></>,
  };
});
