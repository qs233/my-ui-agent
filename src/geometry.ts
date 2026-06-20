import type { TreeNode } from "./types.js";

export function isApproximatelyContained(
  node: Pick<TreeNode, "x" | "y" | "width" | "height" | "area">,
  container: Pick<TreeNode, "x" | "y" | "width" | "height" | "area">,
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

export function shouldMerge(child: TreeNode, parent: TreeNode): boolean {
  if (parent.paintOrder > child.paintOrder) return false;

  const deltaLeft = Math.abs(child.x - parent.x);
  const deltaTop = Math.abs(child.y - parent.y);
  const deltaRight = Math.abs(child.x + child.width - (parent.x + parent.width));
  const deltaBottom = Math.abs(child.y + child.height - (parent.y + parent.height));

  if (child.type === "ENTITY" || parent.type === "ENTITY") {
    const pixelThreshold = 4;
    return (
      deltaLeft <= pixelThreshold &&
      deltaTop <= pixelThreshold &&
      deltaRight <= pixelThreshold &&
      deltaBottom <= pixelThreshold
    );
  }

  const percentThreshold = 0.05;
  const threshX = parent.width * percentThreshold;
  const threshY = parent.height * percentThreshold;
  return (
    deltaLeft <= threshX &&
    deltaTop <= threshY &&
    deltaRight <= threshX &&
    deltaBottom <= threshY
  );
}
