import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { chromium } from "playwright";
import { captureOverview, serializeOverviewText } from "../src/index.js";

const hasChromium = existsSync(chromium.executablePath());

test("captureOverview builds a stable tree from a local page", { skip: !hasChromium }, async () => {
  const url = pathToFileURL(`${process.cwd()}/test/fixtures/overview.html`).href;
  const tree = await captureOverview(url, {
    viewport: { width: 900, height: 700 },
    timeoutMs: 15_000,
  });
  const text = serializeOverviewText(tree);

  assert.match(text, /ZONE html/);
  assert.match(text, /ENTITY button/);
  assert.match(text, /ENTITY input/);
  assert.match(text, /scroll/);
  assert.match(text, /fixed-bar/);
});
