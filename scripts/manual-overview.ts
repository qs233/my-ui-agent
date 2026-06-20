import { captureOverview, serializeOverviewText } from "../src/index.js";

const URL_TO_TEST = "https://google.com";

const tree = await captureOverview(URL_TO_TEST, {
  viewport: { width: 1280, height: 720 },
  timeoutMs: 30_000,
  waitUntil: "load",
});

console.log(serializeOverviewText(tree));
