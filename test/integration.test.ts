import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { chromium } from "playwright";
import { captureOverview, captureOverviewFromPage, hasScrollableOverflow, serializeOverviewText } from "../src/index.js";

const hasChromium = existsSync(chromium.executablePath());

test("captureOverview builds a stable tree from a local page", { skip: !hasChromium }, async () => {
  const url = pathToFileURL(`${process.cwd()}/test/fixtures/overview.html`).href;
  const snapshot = await captureOverview(url, {
    viewport: { width: 900, height: 700 },
    waitUntil: "load",
    timeoutMs: 15_000,
  });
  const text = serializeOverviewText(snapshot);

  assert.equal(snapshot.domNodes instanceof Map, true);
  assert.equal(snapshot.collapsedNodes instanceof Map, true);
  assert.equal(snapshot.vctRoots.length > 0, true);
  assert.match(text, /^\[1\] body/m);
  assert.match(text, /\[\d+\] LEAF button/);
  assert.match(text, /\[\d+\] LEAF input/);
  assert.match(text, /class="scroll-box"[^\n]*maybe-scroll/);
  assert.match(text, /class="hidden-scroll-box"[^\n]*maybe-scroll/);
  assert.match(text, /class="quiet-scroll-box"[^\n]*maybe-scroll/);
  assert.doesNotMatch(text, /scroll-overflow/);
  assert.match(text, /fixed-bar/);
  assert.match(text, /\[\d+\] LEAF h1 text="Account Settings"/);
  assert.match(text, /Generated label/);
  assert.match(text, /Reparented action/);
  assert.doesNotMatch(text, /\b(?:ENTITY|ZONE)\b/);
  assert.doesNotMatch(text, /backendNodeId/);
  assert.doesNotMatch(text, /Invisible action|Hidden content/);
  assert.doesNotMatch(text, /font-family|window\.fixtureLoaded|\.scroll-box\{/);
});

test("hasScrollableOverflow checks a requested node on demand", { skip: !hasChromium }, async () => {
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage();
    await page.setContent(`
      <!doctype html>
      <div class="overflowing" style="overflow:hidden;height:32px;width:100px">
        <div style="height:96px">Tall content</div>
      </div>
      <div class="quiet" style="overflow:auto;height:120px;width:100px">
        <div style="height:24px">Short content</div>
      </div>
    `);
    const snapshot = await captureOverviewFromPage(page);
    const overflowing = [...snapshot.domNodes.values()].find((node) => node.className === "overflowing");
    const quiet = [...snapshot.domNodes.values()].find((node) => node.className === "quiet");

    assert.equal(overflowing?.maybeScrollRegion, true);
    assert.equal(quiet?.maybeScrollRegion, true);
    assert.equal(await hasScrollableOverflow(page, overflowing?.id ?? ""), true);
    assert.equal(await hasScrollableOverflow(page, quiet?.id ?? ""), false);
  } finally {
    await browser.close();
  }
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

    assert.match(text, /\[\d+\] LEAF h2 text="Shadow title"/);
    assert.match(text, /\[\d+\] LEAF button text="Shadow action"/);
    assert.doesNotMatch(text, /\b(?:ENTITY|ZONE)\b/);
    assert.doesNotMatch(text, /width: 120px/);
  } finally {
    await browser.close();
  }
});
