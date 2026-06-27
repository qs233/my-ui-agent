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

  finalizeVctMetadata(roots, options.alignmentResolver);
  return roots;
}

function toVctNode(node: CollapsedNode): VctNode {
  return {
    ...node,
    collapsedDomNodeIds: [...node.collapsedDomNodeIds],
    visualBounds: { ...node.visualBounds },
    ownBounds: { ...node.ownBounds },
    children: [],
    vctId: 0,
    vctParentId: null,
    isCollapsed: node.collapsedDomNodeIds.length > 0,
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
  let currentParentId = node.ctParentId;

  while (currentParentId) {
    const activeParent = nodeMap.get(currentParentId);
    if (!activeParent) break;

    const potentialParent = inserted.get(activeParent.id);
    if (!potentialParent) {
      currentParentId = activeParent.ctParentId;
      continue;
    }

    if (
      isFixedOrSticky(node) &&
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
  if (!isFixedOrSticky(node)) return true;
  return candidate.position === "fixed" || candidate.position === "sticky";
}

function isFixedOrSticky(node: VctNode): boolean {
  return node.position === "fixed" || node.position === "sticky";
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
  alignmentResolver: AlignmentResolver | undefined,
): void {
  const ordered: VctNode[] = [];
  const nodeById = new Map<string, VctNode>();

  function visit(node: VctNode, parent: VctNode | null): void {
    node.vctId = ordered.length + 1;
    node.vctParentId = parent?.vctId ?? null;
    node.isReparented = (parent?.id ?? null) !== node.ctParentId;
    ordered.push(node);
    nodeById.set(node.id, node);
    for (const child of sortSpatially(node.children)) visit(child, node);
  }

  for (const root of sortSpatially(roots)) visit(root, null);

  if (!alignmentResolver) return;

  for (const node of ordered) {
    if (!node.isReparented) continue;
    const aligned = alignmentResolver(node, { candidates: collectAlignmentCandidates(node, nodeById) });
    if (aligned) node.alignToId = aligned.vctId;
  }
}

function collectAlignmentCandidates(node: VctNode, nodeById: ReadonlyMap<string, VctNode>): VctNode[] {
  if (!node.ctParentId) return [];
  const ctParent = nodeById.get(node.ctParentId);
  if (!ctParent) return [];

  return ctParent.children
    .filter((candidate) => candidate !== node)
    .filter((candidate) => candidate.paintOrder <= node.paintOrder)
    .sort((a, b) => compareAlignmentCandidates(node, a, b))
    .slice(0, 5);
}

function compareAlignmentCandidates(node: VctNode, a: VctNode, b: VctNode): number {
  const scoreDelta = alignmentScore(node, b) - alignmentScore(node, a);
  if (scoreDelta !== 0) return scoreDelta;

  const verticalGapDelta = verticalGap(node, a) - verticalGap(node, b);
  if (verticalGapDelta !== 0) return verticalGapDelta;

  const horizontalDelta = horizontalAlignmentDelta(node, a) - horizontalAlignmentDelta(node, b);
  if (horizontalDelta !== 0) return horizontalDelta;

  return a.area - b.area;
}

function alignmentScore(node: VctNode, candidate: VctNode): number {
  const leftDelta = Math.abs(node.x - candidate.x);
  const widthDelta = Math.abs(node.width - candidate.width);
  const centerDelta = Math.abs(node.x + node.width / 2 - (candidate.x + candidate.width / 2));
  const adjacentVerticalGap = verticalGap(node, candidate);
  const horizontalOverlap = Math.max(
    0,
    Math.min(node.x + node.width, candidate.x + candidate.width) - Math.max(node.x, candidate.x),
  );
  const isVerticallyAdjacent = adjacentVerticalGap <= Math.max(12, Math.min(node.height, candidate.height));
  if (!isVerticallyAdjacent) return 0;

  let score = 0;
  if (leftDelta <= 4) score += 1;
  if (widthDelta <= Math.max(4, candidate.width * 0.05)) score += 1;
  if (centerDelta <= 4) score += 1;
  if (adjacentVerticalGap <= Math.max(8, Math.min(node.height, candidate.height) * 0.5)) score += 1;
  if (horizontalOverlap / Math.max(1, Math.min(node.width, candidate.width)) >= 0.8) score += 1;
  return score;
}

function verticalGap(node: VctNode, candidate: VctNode): number {
  return Math.min(
    Math.abs(node.y - (candidate.y + candidate.height)),
    Math.abs(candidate.y - (node.y + node.height)),
  );
}

function horizontalAlignmentDelta(node: VctNode, candidate: VctNode): number {
  const leftDelta = Math.abs(node.x - candidate.x);
  const centerDelta = Math.abs(node.x + node.width / 2 - (candidate.x + candidate.width / 2));
  const rightDelta = Math.abs(node.x + node.width - (candidate.x + candidate.width));
  return Math.min(leftDelta, centerDelta, rightDelta);
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
