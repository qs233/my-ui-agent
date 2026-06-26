import type { CollapsedNode } from "./types.js";

type GeometryNode = Pick<CollapsedNode, "x" | "y" | "width" | "height" | "area">;

export interface OverlapRatios {
  intersectionArea: number;
  childContainmentRatio: number;
  parentOccupancyRatio: number;
  isFullyContained: boolean;
}

export function isApproximatelyContained(
  node: GeometryNode,
  container: GeometryNode,
  threshold = 0.8,
): boolean {
  if (node.area > container.area) return false;
  const ratios = computeOverlapRatios(node, container);
  if (ratios.isFullyContained) return true;
  return ratios.childContainmentRatio >= threshold && ratios.parentOccupancyRatio < 0.5;
}

export function computeOverlapRatios(node: GeometryNode, container: GeometryNode): OverlapRatios {
  const interLeft = Math.max(node.x, container.x);
  const interTop = Math.max(node.y, container.y);
  const interRight = Math.min(node.x + node.width, container.x + container.width);
  const interBottom = Math.min(node.y + node.height, container.y + container.height);

  const interWidth = Math.max(0, interRight - interLeft);
  const interHeight = Math.max(0, interBottom - interTop);
  const overlapArea = interWidth * interHeight;

  return {
    intersectionArea: overlapArea,
    childContainmentRatio: node.area > 0 ? overlapArea / node.area : 0,
    parentOccupancyRatio: container.area > 0 ? overlapArea / container.area : 0,
    isFullyContained:
      node.area > 0 &&
      node.x >= container.x &&
      node.y >= container.y &&
      node.x + node.width <= container.x + container.width &&
      node.y + node.height <= container.y + container.height,
  };
}
