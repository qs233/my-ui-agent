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

interface ParentChoice {
  parent: VctNode | null;
  allowUncontainedParent: boolean;
}

const MAX_DOM_ANCESTOR_SEARCH_DEPTH = 5;

export function buildVisualContainmentTree(
  collapsedNodes: CollapsedNode[],
  options: BuildVisualContainmentTreeOptions = {},
): VctNode[] {
  const nodeMap = new Map<string, VctNode>();
  for (const node of collapsedNodes) nodeMap.set(node.id, toVctNode(node));

  const rtree = buildSpatialIndex([...nodeMap.values()]);
  const parentChoices = resolveParentChoices([...nodeMap.values()], nodeMap, rtree);
  const roots = assembleVctForest([...nodeMap.values()], parentChoices);

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

function buildSpatialIndex(nodes: VctNode[]): RBush<SpatialItem> {
  const rtree = new RBush<SpatialItem>();
  for (const node of nodes) rtree.insert(toSpatialItem(node));
  return rtree;
}

function toSpatialItem(node: VctNode): SpatialItem {
  return {
    minX: node.x,
    minY: node.y,
    maxX: node.x + node.width,
    maxY: node.y + node.height,
    node,
  };
}

function resolveParentChoices(
  nodes: VctNode[],
  nodeMap: Map<string, VctNode>,
  rtree: RBush<SpatialItem>,
): Map<string, ParentChoice> {
  const choices = new Map<string, ParentChoice>();
  for (const node of nodes) choices.set(node.id, resolveParentChoice(node, nodeMap, rtree));
  breakParentCycles(nodes, choices);
  return choices;
}

function resolveParentChoice(
  node: VctNode,
  nodeMap: Map<string, VctNode>,
  rtree: RBush<SpatialItem>,
): ParentChoice {
  const domParent = node.ctParentId ? nodeMap.get(node.ctParentId) : undefined;
  if (domParent && isValidResolvedParent(node, domParent, nodeMap)) {
    return { parent: domParent, allowUncontainedParent: false };
  }

  const domAncestor = findNearestValidDomAncestor(node, nodeMap);
  if (domAncestor) return { parent: domAncestor, allowUncontainedParent: false };

  const spatialParent = findBestSpatialParent(node, rtree, nodeMap);
  if (spatialParent) return { parent: spatialParent, allowUncontainedParent: false };

  if (!isFixedOrSticky(node)) {
    const boundary = findNearestClipBoundary(node, nodeMap);
    if (boundary) return { parent: boundary, allowUncontainedParent: true };
  }

  return { parent: null, allowUncontainedParent: false };
}

function isValidResolvedParent(
  node: VctNode,
  candidateParent: VctNode,
  nodeMap: Map<string, VctNode>,
): boolean {
  return (
    respectsPositioningRule(node, candidateParent) &&
    respectsSpatialContainmentRule(node, candidateParent) &&
    respectsClipBoundary(node, candidateParent, nodeMap)
  );
}

function findNearestValidDomAncestor(
  node: VctNode,
  nodeMap: Map<string, VctNode>,
): VctNode | null {
  let currentParentId = node.ctParentId ? nodeMap.get(node.ctParentId)?.ctParentId : null;
  const seen = new Set<string>();
  let checked = 0;

  while (currentParentId && checked < MAX_DOM_ANCESTOR_SEARCH_DEPTH && !seen.has(currentParentId)) {
    seen.add(currentParentId);
    checked += 1;
    const ancestor = nodeMap.get(currentParentId);
    if (!ancestor) return null;
    if (isValidResolvedParent(node, ancestor, nodeMap)) return ancestor;
    currentParentId = ancestor.ctParentId;
  }

  return null;
}

function breakParentCycles(nodes: VctNode[], choices: Map<string, ParentChoice>): void {
  for (const node of nodes) {
    const choice = choices.get(node.id);
    if (!choice?.parent) continue;
    if (createsParentCycle(node, choice.parent, choices)) {
      choices.set(node.id, { parent: null, allowUncontainedParent: false });
    }
  }
}

function createsParentCycle(
  node: VctNode,
  parent: VctNode,
  choices: ReadonlyMap<string, ParentChoice>,
): boolean {
  const seen = new Set<string>();
  let current: VctNode | null = parent;
  while (current) {
    if (current.id === node.id) return true;
    if (seen.has(current.id)) return false;
    seen.add(current.id);
    current = choices.get(current.id)?.parent ?? null;
  }
  return false;
}

function findBestSpatialParent(
  node: VctNode,
  rtree: RBush<SpatialItem>,
  nodeMap: Map<string, VctNode>,
): VctNode | null {
  const candidates = rtree.search({
    minX: node.x,
    minY: node.y,
    maxX: node.x + node.width,
    maxY: node.y + node.height,
  });

  const validContainers = candidates
    .map((item) => item.node)
    .filter((candidate) => candidate !== node)
    .filter((candidate) => !isSameOrDescendantOf(candidate, node.id, nodeMap))
    .filter((candidate) => isValidResolvedParent(node, candidate, nodeMap));

  if (validContainers.length === 0) return null;
  validContainers.sort((a, b) => a.area - b.area);
  return validContainers[0];
}

function respectsSpatialContainmentRule(node: VctNode, candidate: VctNode): boolean {
  return isApproximatelyContained(node, candidate, 0.8) && candidate.paintOrder <= node.paintOrder;
}

function respectsPositioningRule(node: VctNode, candidate: VctNode): boolean {
  if (!isFixedOrSticky(node)) return true;
  return isFixedOrSticky(candidate);
}

function isFixedOrSticky(node: VctNode): boolean {
  return node.position === "fixed" || node.position === "sticky";
}

function respectsClipBoundary(
  node: VctNode,
  candidateParent: VctNode,
  nodeMap: Map<string, VctNode>,
): boolean {
  if (isFixedOrSticky(node)) return true;
  const boundary = findNearestClipBoundary(node, nodeMap);
  if (!boundary) return true;
  return isSameOrDescendantOf(candidateParent, boundary.id, nodeMap);
}

function findNearestClipBoundary(node: VctNode, nodeMap: Map<string, VctNode>): VctNode | null {
  let currentParentId = node.ctParentId;
  const seen = new Set<string>();

  while (currentParentId && !seen.has(currentParentId)) {
    seen.add(currentParentId);
    const parent = nodeMap.get(currentParentId);
    if (!parent) return null;
    if (parent.maybeScrollRegion) return parent;
    currentParentId = parent.ctParentId;
  }

  return null;
}

function isSameOrDescendantOf(
  node: VctNode,
  ancestorId: string,
  nodeMap: Map<string, VctNode>,
): boolean {
  if (node.id === ancestorId) return true;

  let currentParentId = node.ctParentId;
  const seen = new Set<string>();
  while (currentParentId && !seen.has(currentParentId)) {
    if (currentParentId === ancestorId) return true;
    seen.add(currentParentId);
    currentParentId = nodeMap.get(currentParentId)?.ctParentId ?? null;
  }

  return false;
}

function assembleVctForest(nodes: VctNode[], choices: ReadonlyMap<string, ParentChoice>): VctNode[] {
  const roots: VctNode[] = [];
  for (const node of nodes) {
    node.children = [];
    node.floating = false;
  }

  for (const node of nodes) {
    const choice = choices.get(node.id);
    const parent = choice?.parent ?? null;
    if (!parent) {
      roots.push(node);
      continue;
    }

    parent.children.push(node);
    node.floating = Boolean(choice?.allowUncontainedParent) || !computeOverlapRatios(node, parent).isFullyContained;
  }

  return roots;
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
