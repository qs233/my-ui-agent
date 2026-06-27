import type { CollapsedNode, CollapsedTreeNode, DomNodeRecord } from "./types.js";

interface DomTreeNode {
  record: DomNodeRecord;
  children: DomTreeNode[];
}

export const PRESERVE_COLLAPSE_BOUNDARY_TAGS = new Set([
  "svg",
  "img",
  "video",
  "canvas",
  "picture",
  "audio",
  "iframe",
  "object",
  "embed",
  "math",
  "button",
  "a",
  "input",
  "select",
  "textarea",
  "form",
  "option",
  "summary",
  "details",
  "dialog",
]);

export function collapseDomTree(domNodes: DomNodeRecord[]): CollapsedNode[] {
  const domMap = new Map<string, DomTreeNode>();
  for (const record of domNodes) domMap.set(record.id, { record: { ...record, childIds: [...record.childIds] }, children: [] });

  for (const node of domMap.values()) {
    if (!node.record.parentId) continue;
    domMap.get(node.record.parentId)?.children.push(node);
  }

  const roots = [...domMap.values()].filter(
    (node) => !node.record.parentId || !domMap.has(node.record.parentId),
  );
  const collapsedRoots = roots.map(collapsePostOrder);
  return flattenCollapsedDom(collapsedRoots);
}

function collapsePostOrder(domNode: DomTreeNode): CollapsedTreeNode {
  const children = domNode.children.map(collapsePostOrder);
  const node = classifyNode(domNode.record, children);

  if (node.children.length !== 1) return node;
  const child = node.children[0];
  if (!canCollapseSingleChildWrapper(node, child)) return node;
  return collapseWrapperIntoChild(node, child);
}

function classifyNode(record: DomNodeRecord, children: CollapsedTreeNode[]): CollapsedTreeNode {
  const base = {
    id: record.id,
    representativeDomNodeId: record.id,
    collapsedDomNodeIds: [],
    visualBounds: { ...record.bounds },
    ownBounds: { ...record.bounds },
    x: record.bounds.x,
    y: record.bounds.y,
    width: record.bounds.width,
    height: record.bounds.height,
    area: record.bounds.area,
    ctParentId: record.parentId,
    tagName: record.tagName,
    className: record.className,
    name: record.name,
    text: record.text,
    paintOrder: record.paintOrder,
    position: record.position,
    zIndex: record.zIndex,
    maybeScrollRegion: record.maybeScrollRegion,
    children,
  };

  if (children.length === 0) {
    return { ...base, type: "LEAF" };
  }

  return base;
}

function canCollapseSingleChildWrapper(parent: CollapsedTreeNode, child: CollapsedTreeNode): boolean {
  if (PRESERVE_COLLAPSE_BOUNDARY_TAGS.has(parent.tagName)) return false;
  if (PRESERVE_COLLAPSE_BOUNDARY_TAGS.has(child.tagName)) return false;
  if (shouldPreservePositionedBoundary(parent, child)) return false;
  if (parent.maybeScrollRegion || child.maybeScrollRegion) return false;
  if (parent.paintOrder > child.paintOrder) return false;
  return isFullyContained(child, parent);
}

function collapseWrapperIntoChild(parent: CollapsedTreeNode, child: CollapsedTreeNode): CollapsedTreeNode {
  child.collapsedDomNodeIds = [
    ...parent.collapsedDomNodeIds,
    parent.representativeDomNodeId,
    ...child.collapsedDomNodeIds,
  ];
  child.ctParentId = parent.ctParentId;
  applyVisualBounds(child, parent);
  inheritLayoutProperties(child, parent);
  return child;
}

function flattenCollapsedDom(roots: CollapsedTreeNode[]): CollapsedNode[] {
  const flattened: CollapsedNode[] = [];

  function visit(node: CollapsedTreeNode, parentId: string | null): void {
    node.ctParentId = parentId;
    const { children, ...collapsed } = node;
    flattened.push(cloneCollapsedNode(collapsed as CollapsedNode));
    for (const child of children) visit(child, node.id);
  }

  for (const root of roots) visit(root, null);
  return flattened;
}

function cloneCollapsedNode(node: CollapsedNode): CollapsedNode {
  return {
    ...node,
    collapsedDomNodeIds: [...node.collapsedDomNodeIds],
    visualBounds: { ...node.visualBounds },
    ownBounds: { ...node.ownBounds },
  };
}

function applyVisualBounds(target: CollapsedTreeNode, source: CollapsedTreeNode): void {
  target.visualBounds = { ...source.visualBounds };
  target.x = source.visualBounds.x;
  target.y = source.visualBounds.y;
  target.width = source.visualBounds.width;
  target.height = source.visualBounds.height;
  target.area = source.visualBounds.area;
}

function inheritLayoutProperties(target: CollapsedTreeNode, source: CollapsedTreeNode): void {
  if (source.position !== "static") target.position = source.position;
  if (source.zIndex !== undefined) target.zIndex = source.zIndex;
}

function shouldPreservePositionedBoundary(parent: CollapsedTreeNode, child: CollapsedTreeNode): boolean {
  return isFixedOrSticky(parent) || isFixedOrSticky(child);
}

function isFixedOrSticky(node: CollapsedTreeNode): boolean {
  return node.position === "fixed" || node.position === "sticky";
}

function isFullyContained(node: CollapsedTreeNode, container: CollapsedTreeNode): boolean {
  return (
    node.visualBounds.x >= container.visualBounds.x &&
    node.visualBounds.y >= container.visualBounds.y &&
    node.visualBounds.x + node.visualBounds.width <= container.visualBounds.x + container.visualBounds.width &&
    node.visualBounds.y + node.visualBounds.height <= container.visualBounds.y + container.visualBounds.height
  );
}
