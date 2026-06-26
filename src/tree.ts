import RBush from "rbush";
import { computeOverlapRatios, isApproximatelyContained } from "./geometry.js";
import type {
  AlignmentResolver,
  BuildVisualContainmentTreeOptions,
  CollapsedNode,
  VctNode,
} from "./types.js";

interface SpatialItem {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  node: VctNode;
}

export function buildVisualContainmentTree(
  collapsedNodes: CollapsedNode[],
  options: BuildVisualContainmentTreeOptions = {},
): VctNode[] {
  const nodeMap = new Map<string, VctNode>();
  for (const node of collapsedNodes) nodeMap.set(node.id, toVctNode(node));

  const finalNodes = [...nodeMap.values()].sort((a, b) => {
    const areaDelta = b.area - a.area;
    if (areaDelta !== 0) return areaDelta;
    return a.paintOrder - b.paintOrder;
  });

  const roots: VctNode[] = [];
  const rtree = new RBush<SpatialItem>();
  const inserted = new Map<string, VctNode>();

  for (const node of finalNodes) {
    if (tryInsertByDomFastPath(node, nodeMap, inserted, rtree)) continue;

    const bestParent = findBestSpatialParent(node, rtree);
    if (bestParent) {
      insertIntoTreeWithApprox(bestParent, node);
    } else {
      roots.push(node);
    }

    insertSpatialNode(rtree, node);
    inserted.set(node.id, node);
  }

  finalizeVctMetadata(roots, options.alignmentResolver ?? defaultAlignmentResolver);
  return roots;
}

function toVctNode(node: CollapsedNode): VctNode {
  return {
    ...node,
    wrapperDomIds: [...node.wrapperDomIds],
    children: [],
    vctId: 0,
    vctParentId: null,
    isReparented: false,
    floating: false,
  };
}

function tryInsertByDomFastPath(
  node: VctNode,
  nodeMap: Map<string, VctNode>,
  inserted: Map<string, VctNode>,
  rtree: RBush<SpatialItem>,
): boolean {
  let currentParentId = node.domParentId;

  while (currentParentId) {
    const activeParent = nodeMap.get(currentParentId);
    if (!activeParent) break;

    const potentialParent = inserted.get(activeParent.id);
    if (!potentialParent) {
      currentParentId = activeParent.domParentId;
      continue;
    }

    const isFixedOrSticky = node.position === "fixed" || node.position === "sticky";
    const hasHighZIndex = node.zIndex !== undefined && node.zIndex > 0;
    if (
      (isFixedOrSticky || hasHighZIndex) &&
      potentialParent.position !== "fixed" &&
      potentialParent.position !== "sticky"
    ) {
      break;
    }

    if (canUseAsVctParent(node, potentialParent)) {
      insertIntoTreeWithApprox(potentialParent, node);
      insertSpatialNode(rtree, node);
      inserted.set(node.id, node);
      return true;
    }

    break;
  }

  return false;
}

function findBestSpatialParent(node: VctNode, rtree: RBush<SpatialItem>): VctNode | null {
  const candidates = rtree.search({
    minX: node.x,
    minY: node.y,
    maxX: node.x + node.width,
    maxY: node.y + node.height,
  });

  const validContainers = candidates
    .map((item) => item.node)
    .filter((candidate) => canUseAsVisualParent(node, candidate))
    .filter((candidate) => canUseAsVctParent(node, candidate));

  if (validContainers.length === 0) return null;
  validContainers.sort((a, b) => a.area - b.area);
  return validContainers[0];
}

function canUseAsVctParent(node: VctNode, candidate: VctNode): boolean {
  return isApproximatelyContained(node, candidate, 0.8) && candidate.paintOrder <= node.paintOrder;
}

function canUseAsVisualParent(node: VctNode, candidate: VctNode): boolean {
  const isFloating =
    node.position === "fixed" ||
    node.position === "sticky" ||
    (node.zIndex !== undefined && node.zIndex > 0);
  if (!isFloating) return true;
  return candidate.position === "fixed" || candidate.position === "sticky";
}

export function insertIntoTreeWithApprox(parent: VctNode, node: VctNode): void {
  const nextParent = parent.children
    .filter((child) => child.paintOrder <= node.paintOrder)
    .filter((child) => canUseAsVctParent(node, child))
    .sort((a, b) => a.area - b.area)[0];

  if (nextParent) {
    insertIntoTreeWithApprox(nextParent, node);
    return;
  }

  const subChildren = parent.children.filter(
    (child) => child.paintOrder >= node.paintOrder && canUseAsVctParent(child, node),
  );

  if (subChildren.length > 0) {
    for (const child of subChildren) {
      child.floating = !computeOverlapRatios(child, node).isFullyContained;
    }
    node.children.push(...subChildren);
    const moved = new Set(subChildren);
    parent.children = parent.children.filter((child) => !moved.has(child));
  }

  parent.children.push(node);
  node.floating = !computeOverlapRatios(node, parent).isFullyContained;
}

function insertSpatialNode(rtree: RBush<SpatialItem>, node: VctNode): void {
  rtree.insert({
    minX: node.x,
    minY: node.y,
    maxX: node.x + node.width,
    maxY: node.y + node.height,
    node,
  });
}

function finalizeVctMetadata(
  roots: VctNode[],
  alignmentResolver: AlignmentResolver,
): void {
  const ordered: VctNode[] = [];

  function visit(node: VctNode, parent: VctNode | null): void {
    node.vctId = ordered.length + 1;
    node.vctParentId = parent?.vctId ?? null;
    node.isReparented = (parent?.id ?? null) !== node.domParentId;
    ordered.push(node);
    for (const child of sortSpatially(node.children)) visit(child, node);
  }

  for (const root of sortSpatially(roots)) visit(root, null);

  for (const node of ordered) {
    if (!node.isReparented) continue;
    const aligned = alignmentResolver(node, { candidates: ordered.filter((candidate) => candidate !== node) });
    if (aligned) node.alignToId = aligned.vctId;
  }
}

function defaultAlignmentResolver(node: VctNode, context: { candidates: readonly VctNode[] }): VctNode | undefined {
  let best: { node: VctNode; score: number } | undefined;

  for (const candidate of context.candidates) {
    if (candidate.paintOrder > node.paintOrder) continue;
    if (isDescendantOf(candidate, node)) continue;
    const score = alignmentScore(node, candidate);
    if (score < 3) continue;
    if (!best || score > best.score || (score === best.score && candidate.area < best.node.area)) {
      best = { node: candidate, score };
    }
  }

  return best?.node;
}

function isDescendantOf(candidate: VctNode, ancestor: VctNode): boolean {
  for (const child of ancestor.children) {
    if (child === candidate || isDescendantOf(candidate, child)) return true;
  }
  return false;
}

function alignmentScore(node: VctNode, candidate: VctNode): number {
  const leftDelta = Math.abs(node.x - candidate.x);
  const widthDelta = Math.abs(node.width - candidate.width);
  const centerDelta = Math.abs(node.x + node.width / 2 - (candidate.x + candidate.width / 2));
  const verticalGap = Math.min(
    Math.abs(node.y - (candidate.y + candidate.height)),
    Math.abs(candidate.y - (node.y + node.height)),
  );
  const horizontalOverlap = Math.max(
    0,
    Math.min(node.x + node.width, candidate.x + candidate.width) - Math.max(node.x, candidate.x),
  );
  const isVerticallyAdjacent = verticalGap <= Math.max(12, Math.min(node.height, candidate.height));
  if (!isVerticallyAdjacent) return 0;

  let score = 0;
  if (leftDelta <= 4) score += 1;
  if (widthDelta <= Math.max(4, candidate.width * 0.05)) score += 1;
  if (centerDelta <= 4) score += 1;
  if (verticalGap <= Math.max(8, Math.min(node.height, candidate.height) * 0.5)) score += 1;
  if (horizontalOverlap / Math.max(1, Math.min(node.width, candidate.width)) >= 0.8) score += 1;
  return score;
}

function sortSpatially(nodes: VctNode[]): VctNode[] {
  return [...nodes].sort((a, b) => {
    const yDelta = a.y - b.y;
    if (Math.abs(yDelta) > 2) return yDelta;
    const xDelta = a.x - b.x;
    if (Math.abs(xDelta) > 2) return xDelta;
    return a.paintOrder - b.paintOrder;
  });
}
