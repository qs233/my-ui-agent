import type { CollapsedNode } from "./types.js";

type GeometryNode = Pick<CollapsedNode, "x" | "y" | "width" | "height" | "area">;

export function isApproximatelyContained(
  node: GeometryNode,
  container: GeometryNode,
  threshold = 0.8,
): boolean {
  if (node.area > container.area) return false;

  const interLeft = Math.max(node.x, container.x);
  const interTop = Math.max(node.y, container.y);
  const interRight = Math.min(node.x + node.width, container.x + container.width);
  const interBottom = Math.min(node.y + node.height, container.y + container.height);

  const interWidth = Math.max(0, interRight - interLeft);
  const interHeight = Math.max(0, interBottom - interTop);
  const overlapArea = interWidth * interHeight;

  if (overlapArea === 0 || node.area <= 0) return false;
  return overlapArea / node.area >= threshold;
}
