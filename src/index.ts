import { captureRawNodes } from "./snapshot.js";
import { buildSpatialTree } from "./tree.js";
import type { CaptureOverviewOptions, TreeNode } from "./types.js";

export type {
  CaptureOverviewOptions,
  NodeKind,
  RawNode,
  SerializeOverviewOptions,
  TreeNode,
} from "./types.js";
export { isApproximatelyContained, shouldMerge } from "./geometry.js";
export { rawNodesFromSnapshot, captureRawNodes } from "./snapshot.js";
export { serializeOverviewText } from "./serialize.js";
export { buildSpatialTree } from "./tree.js";

export async function captureOverview(url: string, options: CaptureOverviewOptions = {}): Promise<TreeNode[]> {
  const rawNodes = await captureRawNodes(url, options);
  return buildSpatialTree(rawNodes);
}
