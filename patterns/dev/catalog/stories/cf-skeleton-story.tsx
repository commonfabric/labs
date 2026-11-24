import { NAME, pattern, UI, type VNode } from "commonfabric";

// deno-lint-ignore no-empty-interface
interface SkeletonStoryInput {}
export interface SkeletonStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<SkeletonStoryInput, SkeletonStoryOutput>(() => {
  return {
    [NAME]: "cf-skeleton Story",
    [UI]: (
      <div
        style={{
          padding: "1rem",
          display: "flex",
          flexDirection: "column",
          gap: "24px",
          maxWidth: "400px",
        }}
      >
        <div>
          <div
            style={{
              fontSize: "14px",
              fontWeight: "600",
              marginBottom: "12px",
              color: "#2e3438",
            }}
          >
            Text Variants
          </div>
          <cf-vstack gap="3">
            <cf-skeleton width="100%" height="20px" />
            <cf-skeleton variant="text" width="80%" />
            <cf-skeleton variant="text" width="60%" />
          </cf-vstack>
        </div>

        <div>
          <div
            style={{
              fontSize: "14px",
              fontWeight: "600",
              marginBottom: "12px",
              color: "#2e3438",
            }}
          >
            Card Skeleton
          </div>
          <cf-hstack gap="3" align="center">
            <cf-skeleton variant="circular" width="40px" height="40px" />
            <cf-vstack gap="2" style="flex: 1;">
              <cf-skeleton variant="text" width="70%" />
              <cf-skeleton variant="text" width="40%" />
            </cf-vstack>
          </cf-hstack>
        </div>
      </div>
    ),
    controls: (
      <div style={{ color: "#6b7280", fontSize: "13px", padding: "8px 12px" }}>
        No interactive controls. Variants: default (rectangular), text,
        circular.
      </div>
    ),
  };
});
