import { captureOverview, serializeOverviewText } from "../src/index.js";

const URL_TO_TEST = "https://layui.dev/docs/2/form/";

const tree = await captureOverview(URL_TO_TEST, {
  pageViewport: { width: 1280, height: 720 },
  viewportFilter: true,
  timeoutMs: 30_000,
  waitUntil: "load",
});

console.log(serializeOverviewText(tree));
