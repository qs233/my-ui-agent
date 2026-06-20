import { truncateText } from "./text.js";
import type { SerializeOverviewOptions, TreeNode } from "./types.js";

export function serializeOverviewText(tree: TreeNode[], options: SerializeOverviewOptions = {}): string {
  const lines: string[] = [];
  const sortedRoots = sortSpatially(tree);

  for (const node of sortedRoots) {
    writeNode(lines, node, 0, options);
  }

  return lines.join("\n");
}

function writeNode(lines: string[], node: TreeNode, depth: number, options: SerializeOverviewOptions): void {
  lines.push(`${"  ".repeat(depth)}${formatNode(node, options)}`);

  for (const child of sortSpatially(node.children)) {
    writeNode(lines, child, depth + 1, options);
  }
}

function formatNode(node: TreeNode, options: SerializeOverviewOptions): string {
  const parts = [`${node.type}`, node.tagName];

  if (node.className) parts.push(`class=${quote(compactClassName(node.className))}`);
  if (node.name) parts.push(`name=${quote(node.name)}`);
  if (node.text) parts.push(`text=${quote(truncateText(node.text, options.textMaxLength ?? 80))}`);
  if (node.isScrollable) parts.push("scroll");

  return parts.join(" ");
}

function sortSpatially(nodes: TreeNode[]): TreeNode[] {
  return [...nodes].sort((a, b) => {
    const yDelta = a.y - b.y;
    if (Math.abs(yDelta) > 2) return yDelta;
    const xDelta = a.x - b.x;
    if (Math.abs(xDelta) > 2) return xDelta;
    return a.paintOrder - b.paintOrder;
  });
}

function compactClassName(className: string): string {
  return className.split(/\s+/).filter(Boolean).slice(0, 4).join(".");
}

function quote(value: string): string {
  return JSON.stringify(value);
}
