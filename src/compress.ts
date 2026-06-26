import type { CollapsedNode, CollapsedTreeNode, RawNode } from "./types.js";

interface RawDomNode {
  raw: RawNode;
  children: RawDomNode[];
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

export function collapseDomTree(rawNodes: RawNode[]): CollapsedNode[] {
  const rawMap = new Map<string, RawDomNode>();
  for (const raw of rawNodes) rawMap.set(raw.id, { raw: { ...raw }, children: [] });

  for (const node of rawMap.values()) {
    if (!node.raw.domParentId) continue;
    rawMap.get(node.raw.domParentId)?.children.push(node);
  }

  const roots = [...rawMap.values()].filter(
    (node) => !node.raw.domParentId || !rawMap.has(node.raw.domParentId),
  );
  const collapsedRoots = roots.map(collapsePostOrder);
  return flattenCollapsedDom(collapsedRoots);
}

function collapsePostOrder(rawNode: RawDomNode): CollapsedTreeNode {
  const children = rawNode.children.map(collapsePostOrder);
  const node = classifyNode(rawNode.raw, children);

  if (node.children.length !== 1) return node;
  const child = node.children[0];
  if (!canCollapseSingleChildWrapper(node, child)) return node;
  return collapseWrapperIntoChild(node, child);
}

function classifyNode(raw: RawNode, children: CollapsedTreeNode[]): CollapsedTreeNode {
  const base = {
    ...raw,
    wrapperDomIds: [],
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
  if (isFloatingOutOfOrdinaryParent(child, parent)) return false;
  if (parent.paintOrder > child.paintOrder) return false;
  return isFullyContained(child, parent);
}

function collapseWrapperIntoChild(parent: CollapsedTreeNode, child: CollapsedTreeNode): CollapsedTreeNode {
  child.wrapperDomIds = [...parent.wrapperDomIds, parent.id, ...child.wrapperDomIds];
  child.domParentId = parent.domParentId;
  applyVisualBounds(child, parent);
  inheritLayoutProperties(child, parent);
  return child;
}

function flattenCollapsedDom(roots: CollapsedTreeNode[]): CollapsedNode[] {
  const flattened: CollapsedNode[] = [];

  function visit(node: CollapsedTreeNode, parentId: string | null): void {
    node.domParentId = parentId;
    const { children, ...collapsed } = node;
    flattened.push(cloneCollapsedNode(collapsed as CollapsedNode));
    for (const child of children) visit(child, node.id);
  }

  for (const root of roots) visit(root, null);
  return flattened;
}

function cloneCollapsedNode(node: CollapsedNode): CollapsedNode {
  return { ...node, wrapperDomIds: [...node.wrapperDomIds] };
}

function applyVisualBounds(target: CollapsedTreeNode, source: CollapsedTreeNode): void {
  target.x = source.x;
  target.y = source.y;
  target.width = source.width;
  target.height = source.height;
  target.area = source.area;
}

function inheritLayoutProperties(target: CollapsedTreeNode, source: CollapsedTreeNode): void {
  if (source.position !== "static") target.position = source.position;
  if (source.zIndex !== undefined) target.zIndex = source.zIndex;
  target.isScrollable = target.isScrollable || source.isScrollable;
}

function isFloatingOutOfOrdinaryParent(node: CollapsedTreeNode, parent: CollapsedTreeNode): boolean {
  const isFloating =
    node.position === "fixed" ||
    node.position === "sticky" ||
    (node.zIndex !== undefined && node.zIndex > 0);
  if (!isFloating) return false;
  return parent.position !== "fixed" && parent.position !== "sticky";
}

function isFullyContained(node: CollapsedTreeNode, container: CollapsedTreeNode): boolean {
  return (
    node.x >= container.x &&
    node.y >= container.y &&
    node.x + node.width <= container.x + container.width &&
    node.y + node.height <= container.y + container.height
  );
}
