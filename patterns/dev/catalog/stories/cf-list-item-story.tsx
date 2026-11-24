import { NAME, pattern, UI, type VNode } from "commonfabric";

// deno-lint-ignore no-empty-interface
interface ListItemStoryInput {}
export interface ListItemStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<ListItemStoryInput, ListItemStoryOutput>(() => {
  return {
    [NAME]: "cf-list-item Story",
    [UI]: (
      <div
        style={{
          padding: "1rem",
          display: "flex",
          flexDirection: "column",
          gap: "4px",
          maxWidth: "400px",
        }}
      >
        <cf-heading level={5} style={{ marginBottom: "8px" }}>
          Simple Rows
        </cf-heading>
        <cf-list-item label="Settings"></cf-list-item>
        <cf-list-item label="Profile"></cf-list-item>
        <cf-list-item label="Disabled Item" disabled></cf-list-item>

        <cf-heading
          level={5}
          style={{ marginTop: "16px", marginBottom: "8px" }}
        >
          With Icons
        </cf-heading>
        <cf-list-item label="Home">
          <span slot="icon">🏠</span>
        </cf-list-item>
        <cf-list-item label="Projects" description="View all projects">
          <span slot="icon">📁</span>
        </cf-list-item>
        <cf-list-item label="Activity" description="Recent events">
          <span slot="icon">🔔</span>
        </cf-list-item>

        <cf-heading
          level={5}
          style={{ marginTop: "16px", marginBottom: "8px" }}
        >
          With Actions
        </cf-heading>
        <cf-list-item label="New Project">
          <span slot="icon">📄</span>
          <cf-kbd slot="action">⌘N</cf-kbd>
        </cf-list-item>
        <cf-list-item label="Tasks">
          <span slot="icon">✅</span>
          <cf-badge slot="action">3</cf-badge>
        </cf-list-item>

        <cf-heading
          level={5}
          style={{ marginTop: "16px", marginBottom: "8px" }}
        >
          Expandable
        </cf-heading>
        <cf-list-item label="Project Alpha" expandable>
          <span slot="icon">📦</span>
          <cf-badge slot="action" color="neutral" variant="solid">
            Active
          </cf-badge>
          <div slot="detail" style={{ padding: "8px 8px 8px 36px" }}>
            <cf-vstack gap="1">
              <span style={{ fontSize: "0.75rem", color: "#71747a" }}>
                Building UI · 29 tokens
              </span>
              <cf-badge color="primary" variant="solid">In Progress</cf-badge>
            </cf-vstack>
          </div>
        </cf-list-item>
        <cf-list-item label="Project Beta" expandable>
          <span slot="icon">📦</span>
          <cf-badge slot="action" color="danger" variant="solid">
            Alert
          </cf-badge>
          <div slot="detail" style={{ padding: "8px 8px 8px 36px" }}>
            <span style={{ fontSize: "0.75rem", color: "#71747a" }}>
              Requires attention
            </span>
          </div>
        </cf-list-item>
      </div>
    ),
    controls: (
      <div style={{ color: "#6b7280", fontSize: "13px", padding: "8px 12px" }}>
        Click expandable items to toggle their detail areas.
      </div>
    ),
  };
});
