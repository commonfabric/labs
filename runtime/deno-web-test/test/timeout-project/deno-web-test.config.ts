// Far below the default, so the stuck test in this project is detected in
// about a second rather than thirty. The detector's behavior is what is under
// test here, not the size of the default.
export default {
  testTimeout: 1000,
};
