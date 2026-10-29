import { NAME, pattern, UI, type VNode } from "commonfabric";

// deno-lint-ignore no-empty-interface
interface ChartStoryInput {}
export interface ChartStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<ChartStoryInput, ChartStoryOutput>(() => {
  const lineData = [
    { month: "Jan", value: 30 },
    { month: "Feb", value: 45 },
    { month: "Mar", value: 28 },
    { month: "Apr", value: 62 },
    { month: "May", value: 55 },
    { month: "Jun", value: 78 },
  ];

  const barData = [
    { category: "A", count: 40 },
    { category: "B", count: 65 },
    { category: "C", count: 30 },
    { category: "D", count: 85 },
    { category: "E", count: 50 },
  ];

  return {
    [NAME]: "cf-chart Story",
    [UI]: (
      <div
        style={{
          padding: "1rem",
          display: "flex",
          flexDirection: "column",
          gap: "32px",
        }}
      >
        <div>
          <div
            style={{
              fontSize: "14px",
              fontWeight: "600",
              marginBottom: "8px",
              color: "#2e3438",
            }}
          >
            Line Chart
          </div>
          <cf-chart height={200} xAxis yAxis>
            <cf-line-mark
              data={lineData}
              x="month"
              y="value"
              color="#6366f1"
              label="Monthly"
            />
          </cf-chart>
        </div>

        <div>
          <div
            style={{
              fontSize: "14px",
              fontWeight: "600",
              marginBottom: "8px",
              color: "#2e3438",
            }}
          >
            Area + Line Chart
          </div>
          <cf-chart height={200} xAxis yAxis>
            <cf-area-mark
              data={lineData}
              x="month"
              y="value"
              color="#22c55e"
              opacity={0.15}
            />
            <cf-line-mark
              data={lineData}
              x="month"
              y="value"
              color="#22c55e"
              label="Trend"
            />
          </cf-chart>
        </div>

        <div>
          <div
            style={{
              fontSize: "14px",
              fontWeight: "600",
              marginBottom: "8px",
              color: "#2e3438",
            }}
          >
            Bar Chart
          </div>
          <cf-chart height={200} xAxis yAxis>
            <cf-bar-mark
              data={barData}
              x="category"
              y="count"
              color="#f59e0b"
              label="Count"
            />
          </cf-chart>
        </div>

        <div>
          <div
            style={{
              fontSize: "14px",
              fontWeight: "600",
              marginBottom: "8px",
              color: "#2e3438",
            }}
          >
            Sparkline
          </div>
          <cf-chart height={32} style="width: 120px;">
            <cf-line-mark data={[1, 3, 2, 5, 4, 7, 6, 8]} color="#ef4444" />
          </cf-chart>
        </div>
      </div>
    ),
    controls: (
      <div style={{ color: "#6b7280", fontSize: "13px", padding: "8px 12px" }}>
        No interactive controls. This story shows cf-chart variations.
      </div>
    ),
  };
});
