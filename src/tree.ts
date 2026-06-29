import RBush from "rbush";
import { computeOverlapRatios, isApproximatelyContained } from "./geometry.js";
import type {
  AlignmentResolver,
  BuildVisualContainmentTreeOptions,
  CollapsedTreeNode,
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

interface DomInterval {
  in: number;
  out: number;
}

interface BuildContext {
  nodes: VctNode[];
  nodeMap: Map<string, VctNode>;
  parentById: Map<string, VctNode | null>;
  nearestClipBoundaryById: Map<string, VctNode | null>;
  intervalsById: Map<string, DomInterval>;
  getSpatialIndex: () => RBush<SpatialItem>;
}

const MAX_DOM_ANCESTOR_SEARCH_DEPTH = 5;

export function buildVisualContainmentTree(
  collapsedRoots: CollapsedTreeNode[],
  options: BuildVisualContainmentTreeOptions = {},
): VctNode[] {
  const context = createBuildContext(collapsedRoots);
  const parentChoices = resolveParentChoices(context);
  const roots = assembleVctForest(context.nodes, parentChoices);

  finalizeVctMetadata(roots, options.alignmentResolver);
  return roots;
}

function createBuildContext(collapsedRoots: CollapsedTreeNode[]): BuildContext {
  const nodes: VctNode[] = [];
  const nodeMap = new Map<string, VctNode>();
  const parentById = new Map<string, VctNode | null>();
  const nearestClipBoundaryById = new Map<string, VctNode | null>();
  const intervalsById = new Map<string, DomInterval>();
  let visitClock = 0;
  let rtree: RBush<SpatialItem> | null = null;

  function visit(
    collapsedNode: CollapsedTreeNode,
    parent: VctNode | null,
    nearestClipBoundary: VctNode | null,
  ): VctNode {
    const node = toVctNode(collapsedNode);
    nodes.push(node);
    nodeMap.set(node.id, node);
    parentById.set(node.id, parent);
    nearestClipBoundaryById.set(node.id, nearestClipBoundary);

    const interval = { in: visitClock, out: visitClock };
    visitClock += 1;
    intervalsById.set(node.id, interval);

    const childClipBoundary = node.maybeScrollRegion ? node : nearestClipBoundary;
    for (const child of collapsedNode.children) visit(child, node, childClipBoundary);
    interval.out = visitClock;
    return node;
  }

  for (const root of collapsedRoots) visit(root, null, null);

  return {
    nodes,
    nodeMap,
    parentById,
    nearestClipBoundaryById,
    intervalsById,
    getSpatialIndex: () => {
      if (!rtree) rtree = buildSpatialIndex(nodes);
      return rtree;
    },
  };
}

function toVctNode(node: CollapsedTreeNode): VctNode {
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
  rtree.load(nodes.map(toSpatialItem));
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

function resolveParentChoices(context: BuildContext): Map<string, ParentChoice> {
  const choices = new Map<string, ParentChoice>();
  for (const node of context.nodes) choices.set(node.id, resolveParentChoice(node, context));
  breakParentCycles(context.nodes, choices);
  return choices;
}

function resolveParentChoice(
  node: VctNode,
  context: BuildContext,
): ParentChoice {
  const domParent = context.parentById.get(node.id) ?? null;
  if (domParent && isValidResolvedParent(node, domParent, context)) {
    return { parent: domParent, allowUncontainedParent: false };
  }

  const domAncestor = findNearestValidDomAncestor(node, context);
  if (domAncestor) return { parent: domAncestor, allowUncontainedParent: false };

  const spatialParent = findBestSpatialParent(node, context.getSpatialIndex(), context);
  if (spatialParent) return { parent: spatialParent, allowUncontainedParent: false };

  if (!isFixedOrSticky(node)) {
    const boundary = context.nearestClipBoundaryById.get(node.id) ?? null;
    if (boundary) return { parent: boundary, allowUncontainedParent: true };
  }

  return { parent: null, allowUncontainedParent: false };
}

function isValidResolvedParent(
  node: VctNode,
  candidateParent: VctNode,
  context: BuildContext,
): boolean {
  return (
    respectsPositioningRule(node, candidateParent) &&
    respectsSpatialContainmentRule(node, candidateParent) &&
    respectsClipBoundary(node, candidateParent, context)
  );
}

function findNearestValidDomAncestor(
  node: VctNode,
  context: BuildContext,
): VctNode | null {
  const parent = context.parentById.get(node.id) ?? null;
  let current = parent ? context.parentById.get(parent.id) ?? null : null;
  let checked = 0;

  while (current && checked < MAX_DOM_ANCESTOR_SEARCH_DEPTH) {
    checked += 1;
    if (isValidResolvedParent(node, current, context)) return current;
    current = context.parentById.get(current.id) ?? null;
  }

  return null;
}

function breakParentCycles(nodes: VctNode[], choices: Map<string, ParentChoice>): void {
  const visitState = new Map<string, "visiting" | "visited">();

  for (const node of nodes) {
    if (!visitState.has(node.id)) breakParentCyclesFrom(node, choices, visitState);
  }
}

function breakParentCyclesFrom(
  node: VctNode,
  choices: Map<string, ParentChoice>,
  visitState: Map<string, "visiting" | "visited">,
): void {
  visitState.set(node.id, "visiting");

  const parent = choices.get(node.id)?.parent ?? null;
  if (parent) {
    const parentState = visitState.get(parent.id);
    if (parentState === "visiting") {
      choices.set(node.id, { parent: null, allowUncontainedParent: false });
    } else if (!parentState) {
      breakParentCyclesFrom(parent, choices, visitState);
    }
  }

  visitState.set(node.id, "visited");
}

function findBestSpatialParent(
  node: VctNode,
  rtree: RBush<SpatialItem>,
  context: BuildContext,
): VctNode | null {
  const candidates = rtree.search({
    minX: node.x,
    minY: node.y,
    maxX: node.x + node.width,
    maxY: node.y + node.height,
  });

  let best: VctNode | null = null;
  for (const item of candidates) {
    const candidate = item.node;
    if (candidate === node) continue;
    if (isSameOrDescendantOf(candidate, node.id, context)) continue;
    if (!isValidResolvedParent(node, candidate, context)) continue;
    if (!best || candidate.area < best.area) best = candidate;
  }

  return best;
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
  context: BuildContext,
): boolean {
  if (isFixedOrSticky(node)) return true;
  const boundary = context.nearestClipBoundaryById.get(node.id) ?? null;
  if (!boundary) return true;
  return isSameOrDescendantOf(candidateParent, boundary.id, context);
}

function isSameOrDescendantOf(
  node: VctNode,
  ancestorId: string,
  context: BuildContext,
): boolean {
  const nodeInterval = context.intervalsById.get(node.id);
  const ancestorInterval = context.intervalsById.get(ancestorId);
  if (!nodeInterval || !ancestorInterval) return false;
  return ancestorInterval.in <= nodeInterval.in && nodeInterval.out <= ancestorInterval.out;
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
