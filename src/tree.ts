import RBush from "rbush";
import { isApproximatelyContained, shouldMerge } from "./geometry.js";
import type { RawNode, TreeNode } from "./types.js";

interface SpatialItem {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  node: TreeNode;
}

interface DomMergeState {
  nodeMap: Map<string, TreeNode>;
  mergedTo: Map<string, string>;
}

export function toTreeNode(raw: RawNode): TreeNode {
  return {
    ...raw,
    type: raw.isInteractive ? "ENTITY" : "ZONE",
    mergedDomIds: [raw.id],
    children: [],
  };
}

export function buildSpatialTree(rawNodes: RawNode[]): TreeNode[] {
  const visibleNodes = rawNodes.filter((node) => node.isVisible && node.width > 0 && node.height > 0);
  const mergeState = buildDomTree(visibleNodes);
  const domRoots = findDomRoots(mergeState.nodeMap);

  for (const root of domRoots) {
    postOrderMerge(root, mergeState);
  }

  const liveNodes = collectLiveNodes(domRoots, mergeState.mergedTo);
  for (const node of liveNodes) {
    node.children = [];
  }

  const finalNodes = liveNodes.sort((a, b) => {
    const areaDelta = b.area - a.area;
    if (areaDelta !== 0) return areaDelta;
    return a.paintOrder - b.paintOrder;
  });

  const rootZones: TreeNode[] = [];
  const rtree = new RBush<SpatialItem>();
  const finalInsertedMap = new Map<string, TreeNode>();

  for (const node of finalNodes) {
    if (tryInsertByDomFastPath(node, mergeState, finalInsertedMap, rtree)) {
      continue;
    }

    const bestParent = findBestSpatialParent(node, rtree);
    if (bestParent) {
      insertIntoTreeWithApprox(bestParent, node);
      insertSpatialNode(rtree, node);
      finalInsertedMap.set(node.id, node);
      continue;
    }

    rootZones.push(node);
    insertSpatialNode(rtree, node);
    finalInsertedMap.set(node.id, node);
  }

  return rootZones;
}

function buildDomTree(rawNodes: RawNode[]): DomMergeState {
  const nodeMap = new Map<string, TreeNode>();
  for (const raw of rawNodes) {
    nodeMap.set(raw.id, toTreeNode(raw));
  }

  for (const node of nodeMap.values()) {
    if (!node.domParentId) continue;
    const parent = nodeMap.get(node.domParentId);
    if (parent) parent.children.push(node);
  }

  return {
    nodeMap,
    mergedTo: new Map(),
  };
}

function findDomRoots(nodeMap: Map<string, TreeNode>): TreeNode[] {
  const roots: TreeNode[] = [];
  for (const node of nodeMap.values()) {
    if (!node.domParentId || !nodeMap.has(node.domParentId)) {
      roots.push(node);
    }
  }
  return roots;
}

function postOrderMerge(node: TreeNode, mergeState: DomMergeState): TreeNode {
  const processedChildren = node.children.map((child) => postOrderMerge(child, mergeState));
  const remaining: TreeNode[] = [];

  for (const child of processedChildren) {
    if (shouldMerge(child, node)) {
      absorbChild(node, child, mergeState);
      remaining.push(...child.children);
    } else {
      remaining.push(child);
    }
  }

  node.children = remaining;
  return node;
}

function absorbChild(parent: TreeNode, child: TreeNode, mergeState: DomMergeState): void {
  parent.mergedDomIds.push(...child.mergedDomIds);
  if (child.type === "ENTITY") parent.type = "ENTITY";
  if (!parent.text && child.text) parent.text = child.text;

  for (const mergedId of child.mergedDomIds) {
    mergeState.mergedTo.set(mergedId, parent.id);
  }
  mergeState.mergedTo.set(child.id, parent.id);
}

function collectLiveNodes(domRoots: TreeNode[], mergedTo: Map<string, string>): TreeNode[] {
  const liveNodes: TreeNode[] = [];

  function visit(node: TreeNode): void {
    if (mergedTo.has(node.id)) return;
    liveNodes.push(node);
    for (const child of node.children) visit(child);
  }

  for (const root of domRoots) visit(root);
  return liveNodes;
}

function tryInsertByDomFastPath(
  node: TreeNode,
  mergeState: DomMergeState,
  finalInsertedMap: Map<string, TreeNode>,
  rtree: RBush<SpatialItem>,
): boolean {
  let currentDomParentId = node.domParentId;

  while (currentDomParentId) {
    const activeParent = findActiveRepresentative(currentDomParentId, mergeState);
    if (!activeParent) break;

    const potentialParent = finalInsertedMap.get(activeParent.id);
    if (!potentialParent) {
      currentDomParentId = activeParent.domParentId;
      continue;
    }

    const isFixedOrSticky = node.position === "fixed" || node.position === "sticky";
    const hasHighZIndex = node.zIndex !== undefined && node.zIndex > 0;
    if ((isFixedOrSticky || hasHighZIndex) && potentialParent.position !== "fixed" && potentialParent.position !== "sticky") {
      break;
    }

    if (isApproximatelyContained(node, potentialParent, 0.8) && potentialParent.paintOrder < node.paintOrder) {
      insertIntoTreeWithApprox(potentialParent, node);
      insertSpatialNode(rtree, node);
      finalInsertedMap.set(node.id, node);
      return true;
    }

    break;
  }

  return false;
}

export function findActiveRepresentative(domId: string, mergeState: DomMergeState): TreeNode | null {
  let activeId = domId;
  const seen = new Set<string>();

  while (mergeState.mergedTo.has(activeId)) {
    if (seen.has(activeId)) return null;
    seen.add(activeId);
    activeId = mergeState.mergedTo.get(activeId)!;
  }

  return mergeState.nodeMap.get(activeId) ?? null;
}

function findBestSpatialParent(node: TreeNode, rtree: RBush<SpatialItem>): TreeNode | null {
  const candidates = rtree.search({
    minX: node.x,
    minY: node.y,
    maxX: node.x + node.width,
    maxY: node.y + node.height,
  });

  const validContainers = candidates
    .map((item) => item.node)
    .filter((candidate) => canUseAsVisualParent(node, candidate))
    .filter((candidate) => isApproximatelyContained(node, candidate, 0.8) && candidate.paintOrder < node.paintOrder);

  if (validContainers.length === 0) return null;
  validContainers.sort((a, b) => a.area - b.area);
  return validContainers[0];
}

function canUseAsVisualParent(node: TreeNode, candidate: TreeNode): boolean {
  const isFloating = node.position === "fixed" || node.position === "sticky" || (node.zIndex !== undefined && node.zIndex > 0);
  if (!isFloating) return true;
  return candidate.position === "fixed" || candidate.position === "sticky";
}

export function insertIntoTreeWithApprox(parent: TreeNode, node: TreeNode): void {
  const nextParent = parent.children
    .filter((child) => child.paintOrder < node.paintOrder)
    .filter((child) => isApproximatelyContained(node, child, 0.8))
    .sort((a, b) => a.area - b.area)[0];

  if (nextParent) {
    insertIntoTreeWithApprox(nextParent, node);
    return;
  }

  const subChildren = parent.children.filter(
    (child) => child.paintOrder > node.paintOrder && isApproximatelyContained(child, node, 0.8),
  );

  if (subChildren.length > 0) {
    node.children.push(...subChildren);
    const moved = new Set(subChildren);
    parent.children = parent.children.filter((child) => !moved.has(child));
  }

  parent.children.push(node);
}

function insertSpatialNode(rtree: RBush<SpatialItem>, node: TreeNode): void {
  rtree.insert({
    minX: node.x,
    minY: node.y,
    maxX: node.x + node.width,
    maxY: node.y + node.height,
    node,
  });
}
