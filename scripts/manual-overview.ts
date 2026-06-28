import { chromium } from "playwright";
import { captureOverviewFromPage, serializeOverviewText } from "../src/index.js";

const URL_TO_TEST = "https://layui.dev/docs/2/form/";
const PAGE_VIEWPORT = { width: 1280, height: 720 };
const WAIT_UNTIL = "load" as const;
const TIMEOUT_MS = 30_000;
const HEADLESS = false;

const browser = await chromium.launch({ headless: HEADLESS });
const page = await browser.newPage({ viewport: PAGE_VIEWPORT });

try {
  await page.goto(URL_TO_TEST, {
    waitUntil: WAIT_UNTIL,
    timeout: TIMEOUT_MS,
  });

  await page.waitForTimeout(1_000);

  const tree = await captureOverviewFromPage(page, {
    viewportFilter: true,
  });

  console.log(serializeOverviewText(tree));
} finally {
  await browser.close();
}
