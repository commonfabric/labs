const ED25519_FLAG = "--enable-experimental-web-platform-features";
export default {
  product: "chrome",
  args: [ED25519_FLAG],
  pipeConsole: true,
};
