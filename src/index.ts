import { chromium } from "playwright";
import type { Page } from "playwright";
import { collapseDomTree } from "./compress.js";
import { visibleNodesFromSnapshot } from "./prepare.js";
import { captureSnapshot } from "./snapshot.js";
import { buildVisualContainmentTree } from "./tree.js";
import type {
  Bounds,
  CaptureOverviewOptions,
  CollapsedNode,
  CollapsedTreeNode,
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
  CollapsedTreeNode,
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
  ViewportFilterOptions,
  VctNode,
  VctSnapshot,
} from "./types.js";
export { computeIntersectionArea, computeOverlapRatios, intersectsExpandedViewport, isApproximatelyContained } from "./geometry.js";
export { collapseDomTree } from "./compress.js";
export { decodeSnapshot, prepareNodes, visibleNodesFromSnapshot } from "./prepare.js";
export { captureSnapshot } from "./snapshot.js";
export { serializeOverviewText } from "./serialize.js";
export { buildVisualContainmentTree } from "./tree.js";

export async function captureVisibleNodes(page: Page, options: SnapshotOptions = {}): Promise<DomNodeRecord[]> {
  const snapshotOptions = await resolveSnapshotOptionsForPage(page, options);
  const snapshot = await captureSnapshot(page);
  return visibleNodesFromSnapshot(snapshot, snapshotOptions);
}

export async function captureOverviewFromPage(page: Page, options: SnapshotOptions = {}): Promise<VctSnapshot> {
  const domNodes = await captureVisibleNodes(page, options);
  const collapsedNodes = collapseDomTree(domNodes);
  return createVctSnapshot(domNodes, collapsedNodes);
}

export async function captureOverview(url: string, options: CaptureOverviewOptions = {}): Promise<VctSnapshot> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: options.pageViewport ?? { width: 1280, height: 720 },
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

function createVctSnapshot(domNodes: DomNodeRecord[], collapsedRoots: CollapsedTreeNode[]): VctSnapshot {
  return {
    domNodes: new Map(domNodes.map((node) => [node.id, node])),
    collapsedNodes: flattenCollapsedNodes(collapsedRoots),
    vctRoots: buildVisualContainmentTree(collapsedRoots),
  };
}

function flattenCollapsedNodes(roots: CollapsedTreeNode[]): Map<string, CollapsedNode> {
  const collapsedNodes = new Map<string, CollapsedNode>();

  function visit(node: CollapsedTreeNode): void {
    const { children: _children, ...collapsedNode } = node;
    collapsedNodes.set(node.id, {
      ...collapsedNode,
      collapsedDomNodeIds: [...collapsedNode.collapsedDomNodeIds],
      visualBounds: { ...collapsedNode.visualBounds },
      ownBounds: { ...collapsedNode.ownBounds },
    });
    for (const child of node.children) visit(child);
  }

  for (const root of roots) visit(root);
  return collapsedNodes;
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

async function resolveSnapshotOptionsForPage(page: Page, options: SnapshotOptions): Promise<SnapshotOptions> {
  const filter = options.viewportFilter;
  if (!needsAutoViewport(filter)) return options;

  const { viewport, scale } = await captureSnapshotViewport(page);
  if (filter === true) {
    return {
      ...options,
      viewportFilter: { viewport },
    };
  }
  if (!filter) return options;

  return {
    ...options,
    viewportFilter: {
      ...filter,
      viewport,
      margin: filter.margin === undefined ? undefined : filter.margin * scale,
    },
  };
}

function needsAutoViewport(filter: SnapshotOptions["viewportFilter"]): boolean {
  if (!filter) return false;
  if (filter === true) return true;
  return !filter.viewport;
}

async function captureSnapshotViewport(page: Page): Promise<{ viewport: Bounds; scale: number }> {
  const session = await page.context().newCDPSession(page);
  try {
    const metrics = await session.send("Page.getLayoutMetrics") as PageLayoutMetrics;
    const viewport = metrics.visualViewport ?? metrics.cssVisualViewport;
    const cssViewport = metrics.cssVisualViewport;
    const scale = inferViewportScale(viewport, cssViewport);
    return {
      viewport: {
        x: viewport.pageX,
        y: viewport.pageY,
        width: viewport.clientWidth,
        height: viewport.clientHeight,
        area: Math.max(0, viewport.clientWidth * viewport.clientHeight),
      },
      scale,
    };
  } finally {
    await session.detach().catch(() => undefined);
  }
}

function inferViewportScale(viewport: CdpViewport, cssViewport: CdpViewport): number {
  const widthScale = cssViewport.clientWidth > 0 ? viewport.clientWidth / cssViewport.clientWidth : 0;
  const heightScale = cssViewport.clientHeight > 0 ? viewport.clientHeight / cssViewport.clientHeight : 0;
  if (Number.isFinite(widthScale) && widthScale > 0) return widthScale;
  if (Number.isFinite(heightScale) && heightScale > 0) return heightScale;
  return 1;
}

interface PageLayoutMetrics {
  visualViewport?: CdpViewport;
  cssVisualViewport: CdpViewport;
}

interface CdpViewport {
  pageX: number;
  pageY: number;
  clientWidth: number;
  clientHeight: number;
}
