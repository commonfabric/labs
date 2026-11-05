import { NAME, pattern, UI, type VNode, Writable } from "commonfabric";
import { Controls, SelectControl } from "../ui/controls/index.ts";

// deno-lint-ignore no-empty-interface
interface GridStoryInput {}
export interface GridStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<GridStoryInput, GridStoryOutput>(() => {
  const columns = new Writable("3");
  const gap = new Writable<"2" | "4" | "6" | "8">("4");

  const cellStyle = {
    backgroundColor: "#e0e7ff",
    padding: "16px",
    borderRadius: "4px",
    textAlign: "center" as const,
    fontSize: "13px",
    fontWeight: "500",
    color: "#4338ca",
  };

  return {
    [NAME]: "cf-grid Story",
    [UI]: (
      <div style={{ padding: "1rem" }}>
        <cf-grid columns={columns} gap={gap}>
          <div style={cellStyle}>1</div>
          <div style={cellStyle}>2</div>
          <div style={cellStyle}>3</div>
          <div style={cellStyle}>4</div>
          <div style={cellStyle}>5</div>
          <div style={cellStyle}>6</div>
          <div style={cellStyle}>7</div>
          <div style={cellStyle}>8</div>
          <div style={cellStyle}>9</div>
        </cf-grid>
      </div>
    ),
    controls: (
      <Controls>
        <>
          <SelectControl
            label="columns"
            description="Number of grid columns"
            defaultValue="3"
            value={columns}
            items={[
              { label: "2", value: "2" },
              { label: "3", value: "3" },
              { label: "4", value: "4" },
              { label: "6", value: "6" },
            ]}
          />
          <SelectControl
            label="gap"
            description="Space between items"
            defaultValue="4"
            value={gap}
            items={[
              { label: "2", value: "2" },
              { label: "4", value: "4" },
              { label: "6", value: "6" },
              { label: "8", value: "8" },
            ]}
          />
        </>
      </Controls>
    ),
  };
});
