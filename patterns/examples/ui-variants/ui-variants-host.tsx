import { NAME, pattern, UI } from "commonfabric";
import Demo from "./ui-variants-demo.tsx";
import Counter from "../counter/counter.tsx";

/**
 * CT-1321 browser verification host. Renders one piece that exports all three
 * variants (Demo) and one that exports only [UI] (Counter) through
 * `<cf-render variant=…>`, so we can eyeball the exported variants AND the
 * platform-default failover (chip → cf-cell-link, tile → full [UI] scaled).
 */
const box = {
  border: "1px dashed #c7d2fe",
  borderRadius: "8px",
  padding: "8px",
};

export default pattern(() => {
  const demo = Demo({ title: "Demo Piece" });
  const plain = Counter({});

  return {
    [NAME]: "UI Variants Host",
    [UI]: (
      <div
        style={{
          padding: "16px",
          display: "flex",
          flexDirection: "column",
          gap: "24px",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <section>
          <h3>Piece exports all three variants</h3>
          <div
            style={{ display: "flex", flexDirection: "column", gap: "12px" }}
          >
            <div style={box}>
              <em>chip:</em> <cf-render variant="chip" $cell={demo} />
            </div>
            <div style={box}>
              <em>tile:</em>
              <div style={{ width: "220px", height: "120px" }}>
                <cf-render variant="tile" $cell={demo} />
              </div>
            </div>
            <div style={box}>
              <em>full:</em>
              <cf-render variant="full" $cell={demo} />
            </div>
          </div>
        </section>

        <section>
          <h3>Piece exports only [UI] → platform defaults</h3>
          <div
            style={{ display: "flex", flexDirection: "column", gap: "12px" }}
          >
            <div style={box}>
              <em>chip default (cf-cell-link):</em>{" "}
              <cf-render variant="chip" $cell={plain} />
            </div>
            <div style={box}>
              <em>tile default (full [UI] scaled):</em>
              <div style={{ width: "220px", height: "120px" }}>
                <cf-render variant="tile" $cell={plain} />
              </div>
            </div>
          </div>
        </section>
      </div>
    ),
  };
});
