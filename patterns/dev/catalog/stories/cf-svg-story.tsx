import { NAME, pattern, UI, type VNode, Writable } from "commonfabric";
import { Controls, TextControl } from "../ui/controls/index.ts";

// deno-lint-ignore no-empty-interface
interface SvgStoryInput {}
export interface SvgStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<SvgStoryInput, SvgStoryOutput>(() => {
  const defaultSvg =
    '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="50" r="40" fill="#3b82f6"/></svg>';

  const customSvg = new Writable(defaultSvg);

  const shapesSvg =
    '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><circle cx="30" cy="50" r="25" fill="#3b82f6"/><rect x="60" y="25" width="30" height="50" rx="4" fill="#10b981"/></svg>';

  const gradientSvg =
    '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g1" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#8b5cf6"/><stop offset="100%" stop-color="#ec4899"/></linearGradient></defs><circle cx="50" cy="50" r="40" fill="url(#g1)"/></svg>';

  const starSvg =
    '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" fill="#f59e0b"/></svg>';

  const labelStyle = {
    fontSize: "11px",
    color: "#9ca3af",
    textAlign: "center" as const,
    marginTop: "6px",
  };

  const svgWrapperStyle = {
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    width: "120px",
  };

  return {
    [NAME]: "cf-svg Story",
    [UI]: (
      <div style={{ padding: "1rem" }}>
        <div
          style={{
            fontSize: "12px",
            fontWeight: "600",
            color: "#374151",
            marginBottom: "12px",
            textTransform: "uppercase" as const,
            letterSpacing: "0.05em",
          }}
        >
          Sample SVGs
        </div>
        <div
          style={{
            display: "flex",
            gap: "16px",
            alignItems: "flex-start",
            flexWrap: "wrap",
            marginBottom: "24px",
          }}
        >
          <div style={svgWrapperStyle}>
            <cf-svg content={shapesSvg} />
            <div style={labelStyle}>Simple shapes</div>
          </div>
          <div style={svgWrapperStyle}>
            <cf-svg content={gradientSvg} />
            <div style={labelStyle}>Gradient</div>
          </div>
          <div style={svgWrapperStyle}>
            <cf-svg content={starSvg} />
            <div style={labelStyle}>Path icon</div>
          </div>
        </div>

        <div
          style={{
            fontSize: "12px",
            fontWeight: "600",
            color: "#374151",
            marginBottom: "12px",
            textTransform: "uppercase" as const,
            letterSpacing: "0.05em",
          }}
        >
          Custom SVG
        </div>
        <div style={{ width: "120px" }}>
          <cf-svg content={customSvg} />
        </div>
      </div>
    ),
    controls: (
      <Controls>
        <TextControl
          label="content"
          description="SVG markup string"
          defaultValue={defaultSvg}
          value={customSvg}
        />
      </Controls>
    ),
  };
});
