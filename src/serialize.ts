import { truncateText } from "./text.js";
import type { SerializeOverviewOptions, VctNode, VctSnapshot } from "./types.js";

export function serializeOverviewText(input: VctSnapshot | VctNode[], options: SerializeOverviewOptions = {}): string {
  const lines: string[] = [];
  const tree = Array.isArray(input) ? input : input.vctRoots;
  const sortedRoots = sortSpatially(tree);
  const vctIdByDomId = mapVctIdsByDomId(tree);

  for (const node of sortedRoots) {
    writeNode(lines, node, 0, options, vctIdByDomId);
  }

  return lines.join("\n");
}

function writeNode(
  lines: string[],
  node: VctNode,
  depth: number,
  options: SerializeOverviewOptions,
  vctIdByDomId: ReadonlyMap<string, number>,
): void {
  lines.push(`${"  ".repeat(depth)}${formatNode(node, options, vctIdByDomId)}`);

  for (const child of sortSpatially(node.children)) {
    writeNode(lines, child, depth + 1, options, vctIdByDomId);
  }
}

function formatNode(
  node: VctNode,
  options: SerializeOverviewOptions,
  vctIdByDomId: ReadonlyMap<string, number>,
): string {
  const parts = [`[${node.vctId}]`, isLeafNode(node) ? `LEAF ${node.tagName}` : node.tagName];

  if (node.className) parts.push(`class=${quote(compactClassName(node.className))}`);
  if (node.name) parts.push(`name=${quote(node.name)}`);
  if (node.text) parts.push(`text=${quote(truncateText(node.text, options.textMaxLength ?? 80))}`);
  if (node.maybeScrollRegion) parts.push("maybe-scroll");
  if (node.isCollapsed) parts.push("collapsed");
  if (node.floating) parts.push("floating");
  if (node.isReparented) {
    parts.push("reparented");
    const parentVctId = node.ctParentId ? vctIdByDomId.get(node.ctParentId) : undefined;
    if (parentVctId !== undefined) parts.push(`parent_id=${parentVctId}`);
  }
  if (node.alignToId !== undefined) parts.push(`align_to_id=${node.alignToId}`);

  return parts.join(" ");
}

function isLeafNode(node: VctNode): boolean {
  return "type" in node && node.type === "LEAF";
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

function mapVctIdsByDomId(nodes: VctNode[]): Map<string, number> {
  const ids = new Map<string, number>();

  function visit(node: VctNode): void {
    ids.set(node.id, node.vctId);
    for (const child of node.children) visit(child);
  }

  for (const node of nodes) visit(node);
  return ids;
}

function compactClassName(className: string): string {
  return className.split(/\s+/).filter(Boolean).slice(0, 4).join(".");
}

function quote(value: string): string {
  return JSON.stringify(value);
}
