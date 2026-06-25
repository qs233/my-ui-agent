import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { chromium } from "playwright";
import { captureOverview, captureOverviewFromPage, serializeOverviewText } from "../src/index.js";

const hasChromium = existsSync(chromium.executablePath());

test("captureOverview builds a stable tree from a local page", { skip: !hasChromium }, async () => {
  const url = pathToFileURL(`${process.cwd()}/test/fixtures/overview.html`).href;
  const tree = await captureOverview(url, {
    viewport: { width: 900, height: 700 },
    waitUntil: "load",
    timeoutMs: 15_000,
  });
  const text = serializeOverviewText(tree);

  assert.match(text, /^body/m);
  assert.match(text, /LEAF button/);
  assert.match(text, /LEAF input/);
  assert.match(text, /scroll/);
  assert.match(text, /fixed-bar/);
  assert.match(text, /LEAF h1 text="Account Settings"/);
  assert.match(text, /Generated label/);
  assert.match(text, /Reparented action/);
  assert.doesNotMatch(text, /\b(?:ENTITY|ZONE)\b/);
  assert.doesNotMatch(text, /Invisible action|Hidden content/);
  assert.doesNotMatch(text, /font-family|window\.fixtureLoaded|\.scroll-box\{/);
});

test("captureOverview reads rendered content inside a shadow root", { skip: !hasChromium }, async () => {
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage();
    await page.setContent(`
      <!doctype html>
      <x-card></x-card>
      <script>
        customElements.define("x-card", class extends HTMLElement {
          constructor() {
            super();
            this.attachShadow({ mode: "open" }).innerHTML =
              "<style>button { width: 120px; height: 40px; }</style><h2>Shadow title</h2><button>Shadow action</button>";
          }
        });
      </script>
    `);
    const text = serializeOverviewText(await captureOverviewFromPage(page));

    assert.match(text, /LEAF h2 text="Shadow title"/);
    assert.match(text, /LEAF button text="Shadow action"/);
    assert.doesNotMatch(text, /\b(?:ENTITY|ZONE)\b/);
    assert.doesNotMatch(text, /width: 120px/);
  } finally {
    await browser.close();
  }
});
