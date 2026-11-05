import { NAME, pattern, UI, type VNode } from "commonfabric";

// deno-lint-ignore no-empty-interface
interface TableStoryInput {}
export interface TableStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<TableStoryInput, TableStoryOutput>(() => {
  return {
    [NAME]: "cf-table Story",
    [UI]: (
      <div style={{ padding: "1rem" }}>
        <cf-table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Role</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Alice</td>
              <td>Engineer</td>
              <td>Active</td>
            </tr>
            <tr>
              <td>Bob</td>
              <td>Designer</td>
              <td>Active</td>
            </tr>
            <tr>
              <td>Carol</td>
              <td>Manager</td>
              <td>Away</td>
            </tr>
            <tr>
              <td>Dave</td>
              <td>Engineer</td>
              <td>Offline</td>
            </tr>
          </tbody>
        </cf-table>
      </div>
    ),
    controls: (
      <div style={{ color: "#6b7280", fontSize: "13px", padding: "8px 12px" }}>
        No interactive controls. Attributes: striped, hover, bordered,
        full-width, sticky-header. Sizes: sm, md, lg.
      </div>
    ),
  };
});
