import { chromium } from "playwright";
import type { Page } from "playwright";
import { collapseDomTree } from "./compress.js";
import { rawNodesFromSnapshot } from "./prepare.js";
import { captureSnapshot } from "./snapshot.js";
import { buildVisualContainmentTree } from "./tree.js";
import type {
  CaptureOverviewOptions,
  CollapsedNode,
  DomNodeRecord,
  SnapshotOptions,
  VctSnapshot,
} from "./types.js";

export type {
  AlignmentResolver,
  AlignmentResolverContext,
  BaseCollapsedNode,
  BuildVisualContainmentTreeOptions,
  Bounds,
  CaptureOverviewOptions,
  CollapsedNode,
  DecodedLayoutElement,
  DecodedLayoutNode,
  DecodedLayoutText,
  DomNodeId,
  DomNodeRecord,
  LeafNode,
  RawNode,
  RetainedLayoutElement,
  SerializeOverviewOptions,
  SnapshotDocument,
  SnapshotOptions,
  SnapshotResponse,
  VctNode,
  VctSnapshot,
} from "./types.js";
export { computeOverlapRatios, isApproximatelyContained } from "./geometry.js";
export { collapseDomTree } from "./compress.js";
export { decodeSnapshot, prepareNodes, rawNodesFromSnapshot } from "./prepare.js";
export { captureSnapshot } from "./snapshot.js";
export { serializeOverviewText } from "./serialize.js";
export { buildVisualContainmentTree } from "./tree.js";

export async function captureRawNodes(page: Page, options: SnapshotOptions = {}): Promise<DomNodeRecord[]> {
  const snapshot = await captureSnapshot(page);
  return rawNodesFromSnapshot(snapshot, options);
}

export async function captureOverviewFromPage(page: Page, options: SnapshotOptions = {}): Promise<VctSnapshot> {
  const domNodes = await captureRawNodes(page, options);
  const collapsedNodes = collapseDomTree(domNodes);
  return createVctSnapshot(domNodes, collapsedNodes);
}

export async function captureOverview(url: string, options: CaptureOverviewOptions = {}): Promise<VctSnapshot> {
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

function createVctSnapshot(domNodes: DomNodeRecord[], collapsedNodes: CollapsedNode[]): VctSnapshot {
  return {
    domNodes: new Map(domNodes.map((node) => [node.id, node])),
    collapsedNodes: new Map(collapsedNodes.map((node) => [node.id, node])),
    vctRoots: buildVisualContainmentTree(collapsedNodes),
  };
}

export async function hasScrollableOverflow(page: Page, domNodeId: string): Promise<boolean> {
  const session = await page.context().newCDPSession(page);
  try {
    const backendNodeId = Number(domNodeId);
    if (!Number.isFinite(backendNodeId)) return false;

    const resolved = await session.send("DOM.resolveNode", {
      backendNodeId,
      objectGroup: "scroll-metrics",
    });
    const objectId = resolved.object.objectId;
    if (!objectId) return false;

    const result = await session.send("Runtime.callFunctionOn", {
      objectId,
      returnByValue: true,
      functionDeclaration: `function () {
        return {
          clientWidth: this.clientWidth,
          clientHeight: this.clientHeight,
          scrollWidth: this.scrollWidth,
          scrollHeight: this.scrollHeight
        };
      }`,
    });

    const metrics = result.result.value as ScrollMetrics | undefined;
    if (!metrics) return false;
    return (
      metrics.scrollWidth > metrics.clientWidth + 1 ||
      metrics.scrollHeight > metrics.clientHeight + 1
    );
  } finally {
    await session.send("Runtime.releaseObjectGroup", { objectGroup: "scroll-metrics" }).catch(() => undefined);
    await session.detach().catch(() => undefined);
  }
}

interface ScrollMetrics {
  clientWidth: number;
  clientHeight: number;
  scrollWidth: number;
  scrollHeight: number;
}
