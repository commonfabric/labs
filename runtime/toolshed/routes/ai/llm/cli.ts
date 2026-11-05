// Add color utility functions at the top
export const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
};

// Helper for timestamps
export const timestamp = () =>
  colors.dim + new Date().toLocaleTimeString() + colors.reset;
export const timeTrack = (start: number) =>
  colors.gray + `${(Date.now() - start).toFixed(0)}ms` + colors.reset;
