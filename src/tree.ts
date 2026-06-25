import RBush from "rbush";
import { isApproximatelyContained } from "./geometry.js";
import type { CollapsedNode, TreeNode } from "./types.js";

interface SpatialItem {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  node: TreeNode;
}

export function buildVisualContainmentTree(collapsedNodes: CollapsedNode[]): TreeNode[] {
  const nodeMap = new Map<string, TreeNode>();
  for (const node of collapsedNodes) nodeMap.set(node.id, toTreeNode(node));

  const finalNodes = [...nodeMap.values()].sort((a, b) => {
    const areaDelta = b.area - a.area;
    if (areaDelta !== 0) return areaDelta;
    return a.paintOrder - b.paintOrder;
  });

  const roots: TreeNode[] = [];
  const rtree = new RBush<SpatialItem>();
  const inserted = new Map<string, TreeNode>();

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

  return roots;
}

function toTreeNode(node: CollapsedNode): TreeNode {
  return { ...node, wrapperDomIds: [...node.wrapperDomIds], children: [] };
}

function tryInsertByDomFastPath(
  node: TreeNode,
  nodeMap: Map<string, TreeNode>,
  inserted: Map<string, TreeNode>,
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

    if (isApproximatelyContained(node, potentialParent, 0.8) && potentialParent.paintOrder <= node.paintOrder) {
      insertIntoTreeWithApprox(potentialParent, node);
      insertSpatialNode(rtree, node);
      inserted.set(node.id, node);
      return true;
    }

    break;
  }

  return false;
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
    .filter((candidate) => isApproximatelyContained(node, candidate, 0.8) && candidate.paintOrder <= node.paintOrder);

  if (validContainers.length === 0) return null;
  validContainers.sort((a, b) => a.area - b.area);
  return validContainers[0];
}

function canUseAsVisualParent(node: TreeNode, candidate: TreeNode): boolean {
  const isFloating =
    node.position === "fixed" ||
    node.position === "sticky" ||
    (node.zIndex !== undefined && node.zIndex > 0);
  if (!isFloating) return true;
  return candidate.position === "fixed" || candidate.position === "sticky";
}

export function insertIntoTreeWithApprox(parent: TreeNode, node: TreeNode): void {
  const nextParent = parent.children
    .filter((child) => child.paintOrder <= node.paintOrder)
    .filter((child) => isApproximatelyContained(node, child, 0.8))
    .sort((a, b) => a.area - b.area)[0];

  if (nextParent) {
    insertIntoTreeWithApprox(nextParent, node);
    return;
  }

  const subChildren = parent.children.filter(
    (child) => child.paintOrder >= node.paintOrder && isApproximatelyContained(child, node, 0.8),
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
