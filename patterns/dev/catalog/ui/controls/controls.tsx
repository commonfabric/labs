import { NAME, pattern, UI, type VNode } from "commonfabric";

interface ControlsInput {
  children?: VNode;
}

export interface ControlsOutput {
  [NAME]: string;
  [UI]: VNode;
}

const headerCell = { padding: "0 12px" };
const styles = {
  header: {
    display: "flex",
    borderBottom: "1px solid var(--cf-theme-color-border, #e6e9ed)",
    padding: "8px 0",
    fontSize: "11px",
    fontWeight: "700",
    color: "var(--cf-theme-color-text-muted, #798186)",
    textTransform: "uppercase",
    letterSpacing: "0.08em",
  },
  colName: { ...headerCell, width: "140px" },
  colDescription: { ...headerCell, flex: "1" },
  colDefault: { ...headerCell, width: "100px" },
  colControl: { ...headerCell, width: "200px" },
};

export const Controls = pattern<ControlsInput, ControlsOutput>(
  ({ children }) => {
    return {
      [NAME]: "Controls",
      [UI]: (
        <div>
          <div style={styles.header}>
            <div style={styles.colName}>Name</div>
            <div style={styles.colDescription}>Description</div>
            <div style={styles.colDefault}>Default</div>
            <div style={styles.colControl}>Control</div>
          </div>
          {children}
        </div>
      ),
    };
  },
);
