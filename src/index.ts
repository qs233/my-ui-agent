import { chromium } from "playwright";
import type { Page } from "playwright";
import { compressDomTree } from "./compress.js";
import { decodeSnapshot, prepareNodes } from "./prepare.js";
import { captureSnapshot } from "./snapshot.js";
import { buildSpatialTree } from "./tree.js";
import type { CaptureOverviewOptions, RawNode, SnapshotOptions, TreeNode } from "./types.js";

export type {
  BaseCompressedNode,
  Bounds,
  CaptureOverviewOptions,
  CompressedNode,
  DecodedLayoutElement,
  DecodedLayoutNode,
  DecodedLayoutText,
  EntityNode,
  LeafNode,
  NodeKind,
  RawNode,
  RetainedLayoutElement,
  SerializeOverviewOptions,
  SnapshotDocument,
  SnapshotOptions,
  SnapshotResponse,
  TreeNode,
  ZoneNode,
} from "./types.js";
export { isApproximatelyContained, shouldMerge } from "./geometry.js";
export { compressDomTree } from "./compress.js";
export { decodeSnapshot, prepareNodes, rawNodesFromSnapshot } from "./prepare.js";
export { captureSnapshot } from "./snapshot.js";
export { serializeOverviewText } from "./serialize.js";
export { buildSpatialTree } from "./tree.js";

export async function captureRawNodes(page: Page, options: SnapshotOptions = {}): Promise<RawNode[]> {
  const snapshot = await captureSnapshot(page);
  return prepareNodes(decodeSnapshot(snapshot), options);
}

export async function captureOverviewFromPage(page: Page, options: SnapshotOptions = {}): Promise<TreeNode[]> {
  const rawNodes = await captureRawNodes(page, options);
  const compressedNodes = compressDomTree(rawNodes);
  return buildSpatialTree(compressedNodes);
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
