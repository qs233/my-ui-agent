import { chromium } from "playwright";
import type { Page } from "playwright";
import { collapseDomTree } from "./compress.js";
import { rawNodesFromSnapshot } from "./prepare.js";
import { captureSnapshot } from "./snapshot.js";
import { buildVisualContainmentTree } from "./tree.js";
import type { CaptureOverviewOptions, RawNode, SnapshotOptions, TreeNode } from "./types.js";

export type {
  BaseCollapsedNode,
  Bounds,
  CaptureOverviewOptions,
  CollapsedNode,
  DecodedLayoutElement,
  DecodedLayoutNode,
  DecodedLayoutText,
  LeafNode,
  RawNode,
  RetainedLayoutElement,
  SerializeOverviewOptions,
  SnapshotDocument,
  SnapshotOptions,
  SnapshotResponse,
  TreeNode,
} from "./types.js";
export { isApproximatelyContained } from "./geometry.js";
export { collapseDomTree } from "./compress.js";
export { decodeSnapshot, prepareNodes, rawNodesFromSnapshot } from "./prepare.js";
export { captureSnapshot } from "./snapshot.js";
export { serializeOverviewText } from "./serialize.js";
export { buildVisualContainmentTree } from "./tree.js";

export async function captureRawNodes(page: Page, options: SnapshotOptions = {}): Promise<RawNode[]> {
  const snapshot = await captureSnapshot(page);
  return rawNodesFromSnapshot(snapshot, options);
}

export async function captureOverviewFromPage(page: Page, options: SnapshotOptions = {}): Promise<TreeNode[]> {
  const rawNodes = await captureRawNodes(page, options);
  const collapsedNodes = collapseDomTree(rawNodes);
  return buildVisualContainmentTree(collapsedNodes);
}

export async function captureOverview(url: string, options: CaptureOverviewOptions = {}): Promise<TreeNode[]> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: options.viewport ?? { width: 1280, height: 720 },
  });

  try {
    await page.goto(url, {
      waitUntil: options.waitUntil ?? "load",
      timeout: options.timeoutMs ?? 30_000,
    });
    return await captureOverviewFromPage(page, options);
  } finally {
    if (!options.keepBrowserOpen) {
      await browser.close();
    }
  }
}
