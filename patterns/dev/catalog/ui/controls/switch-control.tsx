import { NAME, pattern, UI, type VNode, Writable } from "commonfabric";

interface SwitchControlInput {
  label: string;
  description?: string;
  defaultValue?: string;
  checked: Writable<boolean>;
}

export interface SwitchControlOutput {
  [NAME]: string;
  [UI]: VNode;
}

const styles = {
  root: {
    display: "flex",
    alignItems: "center",
    borderBottom: "1px solid var(--cf-theme-color-border-muted, #f0f1f3)",
    padding: "10px 0",
    fontSize: "13px",
  },
  colName: {
    width: "140px",
    padding: "0 12px",
    fontWeight: "600",
    color: "var(--cf-theme-color-text, #2e3438)",
  },
  colDescription: {
    flex: "1",
    padding: "0 12px",
    color: "var(--cf-theme-color-text-muted, #798186)",
    fontSize: "12px",
  },
  colDefault: {
    width: "100px",
    padding: "0 12px",
    color: "var(--cf-theme-color-text-muted, #798186)",
    fontSize: "12px",
    fontFamily: "monospace",
  },
  colControl: { width: "200px", padding: "0 12px" },
};

export const SwitchControl = pattern<SwitchControlInput, SwitchControlOutput>(
  ({ label, description, defaultValue, checked }) => {
    return {
      [NAME]: "SwitchControl",
      [UI]: (
        <div style={styles.root}>
          <div style={styles.colName}>{label}</div>
          <div style={styles.colDescription}>{description}</div>
          <div style={styles.colDefault}>{defaultValue}</div>
          <div style={styles.colControl}>
            <cf-switch $checked={checked} />
          </div>
        </div>
      ),
    };
  },
);
