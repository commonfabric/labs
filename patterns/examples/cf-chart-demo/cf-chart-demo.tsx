import { computed, NAME, pattern, UI } from "commonfabric";

export default pattern(() => {
  // Line chart data - simple number array (auto-indexed x)
  const sparklineData = computed(() => [1, 3, 2, 5, 4, 7, 6, 8, 5, 9, 7, 10]);

  // Time series data
  const priceData = computed(() => {
    const base = 150;
    const points = [];
    for (let i = 0; i < 30; i++) {
      const date = new Date(2025, 0, i + 1);
      points.push({
        date: date.toISOString(),
        price: base + Math.sin(i / 3) * 20 + i * 0.5,
      });
    }
    return points;
  });

  // Bar chart data
  const monthlyData = computed(() => [
    { month: "Jan", revenue: 4200 },
    { month: "Feb", revenue: 5100 },
    { month: "Mar", revenue: 3800 },
    { month: "Apr", revenue: 6200 },
    { month: "May", revenue: 5500 },
    { month: "Jun", revenue: 7100 },
  ]);

  return {
    [NAME]: "Chart Demo",
    [UI]: (
      <div style="display: flex; flex-direction: column; gap: 24px; padding: 16px;">
        <h2>cf-chart Demo</h2>

        {/* Sparkline */}
        <div>
          <h3>Sparkline (inline, no axes)</h3>
          <div style="display: flex; align-items: center; gap: 8px;">
            <span>Trend:</span>
            <cf-chart height={24} style="width: 100px;">
              <cf-line-mark $data={sparklineData} color="#22c55e" />
            </cf-chart>
          </div>
        </div>

        {/* Line chart with axes + grid + labels */}
        <div>
          <h3>Line Chart (with labels and grid)</h3>
          <cf-chart
            height={200}
            xAxis={{ label: "Date" }}
            yAxis={{ label: "Price ($)", grid: true }}
          >
            <cf-line-mark
              $data={priceData}
              x="date"
              y="price"
              color="#3b82f6"
              label="Price"
            />
          </cf-chart>
        </div>

        {/* Layered area + line */}
        <div>
          <h3>Area + Line (layered)</h3>
          <cf-chart height={200} xAxis yAxis>
            <cf-area-mark
              $data={priceData}
              x="date"
              y="price"
              color="#3b82f6"
              opacity={0.15}
            />
            <cf-line-mark
              $data={priceData}
              x="date"
              y="price"
              color="#3b82f6"
              label="Price"
            />
          </cf-chart>
        </div>

        {/* Bar chart */}
        <div>
          <h3>Bar Chart</h3>
          <cf-chart height={200} xAxis yAxis>
            <cf-bar-mark
              $data={monthlyData}
              x="month"
              y="revenue"
              color="#22c55e"
              label="Revenue"
            />
          </cf-chart>
        </div>

        {/* Dot/scatter */}
        <div>
          <h3>Scatter Plot</h3>
          <cf-chart height={200} xAxis yAxis>
            <cf-dot-mark
              $data={priceData}
              x="date"
              y="price"
              color="#f59e0b"
              radius={3}
              label="Price"
            />
          </cf-chart>
        </div>
      </div>
    ),
  };
});
