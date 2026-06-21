import { shouldMerge } from "./geometry.js";
import { appendText, normalizeText } from "./text.js";
import type {
  CompressedNode,
  EntityNode,
  LeafNode,
  RawNode,
  TreeNode,
  ZoneNode,
} from "./types.js";

interface RawDomNode {
  raw: RawNode;
  children: RawDomNode[];
}

interface CompressionState {
  mergeBoundaries: Set<string>;
}

type SemanticTreeNode = Extract<TreeNode, { type: "ENTITY" | "LEAF" }>;

export function compressDomTree(rawNodes: RawNode[]): CompressedNode[] {
  const rawMap = new Map<string, RawDomNode>();
  for (const raw of rawNodes) rawMap.set(raw.id, { raw: { ...raw }, children: [] });

  for (const node of rawMap.values()) {
    if (!node.raw.domParentId) continue;
    rawMap.get(node.raw.domParentId)?.children.push(node);
  }

  const roots = [...rawMap.values()].filter(
    (node) => !node.raw.domParentId || !rawMap.has(node.raw.domParentId),
  );
  const state: CompressionState = { mergeBoundaries: new Set() };
  const compressedRoots = roots.map((root) => compressPostOrder(root, state));
  return flattenCompressedDom(compressedRoots);
}

function compressPostOrder(rawNode: RawDomNode, state: CompressionState): TreeNode {
  const children = rawNode.children.map((child) => compressPostOrder(child, state));
  let node = classifyNode(rawNode.raw, children);

  if (node.type === "ENTITY" && node.entityKind === "interactive") {
    node.children = consumeTextEntities(node.children, node);
  }

  if (node.type === "ZONE" && node.children.length === 0) {
    node = zoneToLeaf(node);
  }

  if (node.children.length !== 1) return node;
  const child = node.children[0];
  if (!shouldMerge(child, node)) return node;

  if (node.type === "ZONE" && (child.type === "ENTITY" || child.type === "LEAF")) {
    if (state.mergeBoundaries.has(child.id)) return node;
    return absorbZoneIntoSemanticNode(node, child, state);
  }

  if (node.type === "ZONE" && child.type === "ZONE") {
    if (isLayoutBoundary(child)) return node;
    return absorbZoneIntoZone(node, child);
  }

  return node;
}

function classifyNode(raw: RawNode, children: TreeNode[]): TreeNode {
  const base = {
    ...raw,
    mergedDomIds: [raw.id],
    children,
  };

  if (raw.isInteractive || normalizeText(raw.text)) {
    return {
      ...base,
      type: "ENTITY",
      entityKind: raw.isInteractive ? "interactive" : "text",
      semanticBounds: boundsFromNode(raw),
    };
  }

  if (children.length === 0) {
    return {
      ...base,
      type: "LEAF",
      semanticBounds: boundsFromNode(raw),
    };
  }

  return { ...base, type: "ZONE" };
}

function absorbZoneIntoSemanticNode(
  parent: TreeNode & ZoneNode,
  child: SemanticTreeNode,
  state: CompressionState,
): SemanticTreeNode {
  child.mergedDomIds = uniqueIds([...parent.mergedDomIds, ...child.mergedDomIds]);
  child.domParentId = parent.domParentId;
  applyVisualBounds(child, parent);
  inheritLayoutProperties(child, parent);
  if (isLayoutBoundary(parent)) state.mergeBoundaries.add(child.id);
  return child;
}

function absorbZoneIntoZone(parent: TreeNode & ZoneNode, child: TreeNode & ZoneNode): TreeNode & ZoneNode {
  parent.mergedDomIds = uniqueIds([...parent.mergedDomIds, ...child.mergedDomIds]);
  parent.children = child.children;
  inheritLayoutProperties(parent, child);
  return parent;
}

function consumeTextEntities(children: TreeNode[], owner: TreeNode & EntityNode): TreeNode[] {
  const remaining: TreeNode[] = [];

  for (let child of children) {
    if (child.type === "ENTITY") {
      if (child.entityKind === "interactive") {
        remaining.push(child);
        continue;
      }

      owner.text = mergeEntityText(owner.text, child.text);
      owner.mergedDomIds = uniqueIds([...owner.mergedDomIds, ...child.mergedDomIds]);
      remaining.push(...child.children);
      continue;
    }

    child.children = consumeTextEntities(child.children, owner);
    if (child.type === "ZONE" && child.children.length === 0) child = zoneToLeaf(child);
    remaining.push(child);
  }

  return remaining;
}

function zoneToLeaf(zone: TreeNode & ZoneNode): TreeNode & LeafNode {
  const { type: _type, ...rest } = zone;
  return {
    ...rest,
    type: "LEAF",
    semanticBounds: boundsFromNode(zone),
  };
}

function flattenCompressedDom(roots: TreeNode[]): CompressedNode[] {
  const flattened: CompressedNode[] = [];

  function visit(node: TreeNode, parentId: string | null): void {
    node.domParentId = parentId;
    const { children, ...compressed } = node;
    flattened.push(cloneCompressedNode(compressed as CompressedNode));
    for (const child of children) visit(child, node.id);
  }

  for (const root of roots) visit(root, null);
  return flattened;
}

function cloneCompressedNode(node: CompressedNode): CompressedNode {
  const cloned = { ...node, mergedDomIds: [...node.mergedDomIds] };
  if (cloned.type === "ENTITY" || cloned.type === "LEAF") {
    cloned.semanticBounds = { ...cloned.semanticBounds };
  }
  return cloned;
}

function applyVisualBounds(target: TreeNode, source: TreeNode): void {
  target.x = source.x;
  target.y = source.y;
  target.width = source.width;
  target.height = source.height;
  target.area = source.area;
}

function inheritLayoutProperties(target: TreeNode, source: TreeNode): void {
  if (source.position !== "static") target.position = source.position;
  if (source.zIndex !== undefined) target.zIndex = source.zIndex;
  target.isScrollable = target.isScrollable || source.isScrollable;
}

function isLayoutBoundary(node: TreeNode): boolean {
  return (
    node.position === "fixed" ||
    node.position === "sticky" ||
    node.isScrollable ||
    node.zIndex !== undefined
  );
}

function mergeEntityText(current: string, next: string): string {
  const normalizedCurrent = normalizeText(current);
  const normalizedNext = normalizeText(next);
  if (!normalizedNext || normalizedCurrent.includes(normalizedNext)) return normalizedCurrent;
  if (!normalizedCurrent || normalizedNext.includes(normalizedCurrent)) return normalizedNext;
  return appendText(normalizedCurrent, normalizedNext);
}

function boundsFromNode(node: RawNode) {
  return {
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    area: node.area,
  };
}

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids)];
}
