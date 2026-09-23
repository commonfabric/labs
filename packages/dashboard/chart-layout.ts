import { TRUST_COLS } from "./ci-trust-layout.ts";
import { statusDotRules } from "./status-dot.ts";

export const LABELED_CELL_GRID_MARGIN_TOP = 9;
export const CHART_BOTTOM_INSET = 2;
const CELL_GRID_GAP = 1;
const CELL_GRID_MAX_SIZE = 7.5;
export const DASHBOARD_GRID_RULE =
  `.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;margin-bottom:12px}`;
export const TILE_BOX_RULE =
  `.tile{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px 16px;position:relative;isolation:isolate;overflow:hidden}`;
export const BOTTOM_CHART_RULES =
  `.tile.bottom-chart{display:flex;flex-direction:column}
  a.tile.link.bottom-chart{display:flex}
  .tile.bottom-chart .chart{margin-top:auto}`;
export const TILE_LABEL_RULE =
  `.lbl{font-size:11px;line-height:15px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted);margin:0 0 7px;display:flex;align-items:center;gap:7px;white-space:nowrap}`;

export function labeledCellGridRule(
  chartHeight: number,
): string {
  return `.cells.labeled{margin-top:${LABELED_CELL_GRID_MARGIN_TOP}px;height:${chartHeight}px;align-content:end;align-items:start;transform:translateY(-${CHART_BOTTOM_INSET}px)}`;
}

export function tileContentRules(
  chartHeight: number,
): string {
  return `${TILE_LABEL_RULE}
  .lbl .spacer{flex:1}
  .drill{min-width:0;overflow:hidden;text-overflow:ellipsis;font-size:10px;color:var(--text-muted);letter-spacing:0;text-transform:none}
  .hfacet{min-width:0;overflow:hidden;text-overflow:ellipsis;font-size:11px;color:var(--text-muted);letter-spacing:0;text-transform:none;font-variant-numeric:tabular-nums;margin-right:8px}
  .big{font-size:30px;font-weight:600;margin:0;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .sub{font-size:13px;color:var(--text-muted);margin:5px 0 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .running{display:inline-flex;align-items:center;gap:5px;font-size:10px;color:var(--text-muted);letter-spacing:.02em;text-transform:none;margin-top:10px}
  .lbl .running{margin-top:0;margin-right:8px}
  .rdot{width:7px;height:7px;border-radius:50%;background:var(--running);flex:none}
  .tile-detail-list{max-height:${
    chartHeight + 9
  }px;overflow-y:auto;overflow-x:hidden;scrollbar-gutter:stable}
  .tile-detail-list>div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .chart>span:last-child{bottom:${CHART_BOTTOM_INSET}px!important}
  .cells{display:grid;grid-template-columns:repeat(${TRUST_COLS},min(${CELL_GRID_MAX_SIZE}px,calc((100% - ${
    (TRUST_COLS - 1) * CELL_GRID_GAP
  }px)/${TRUST_COLS})));column-gap:${CELL_GRID_GAP}px;row-gap:${CELL_GRID_GAP}px;justify-content:space-between;margin-top:10px}
  ${labeledCellGridRule(chartHeight)}
  .cells.labeled .cell{width:100%}
  .cells.labeled+span{font-weight:700;text-shadow:-1px -1px 0 var(--surface),1px -1px 0 var(--surface),-1px 1px 0 var(--surface),1px 1px 0 var(--surface),0 0 4px var(--surface);z-index:1}
  .cell{aspect-ratio:1;border-radius:1px}
  ${statusDotRules()}
  .swatch{display:inline-block;width:8px;height:8px;border-radius:2px;vertical-align:middle}
  a.tile.link{display:block;text-decoration:none;color:inherit;cursor:pointer;transition:border-color .12s}`;
}
