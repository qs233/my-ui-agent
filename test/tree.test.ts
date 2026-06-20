import assert from "node:assert/strict";
import test from "node:test";
import { isApproximatelyContained, shouldMerge } from "../src/geometry.js";
import { buildSpatialTree } from "../src/tree.js";
import { truncateText } from "../src/text.js";
import type { RawNode, TreeNode } from "../src/types.js";

test("isApproximatelyContained rejects larger children and accepts mostly contained nodes", () => {
  assert.equal(
    isApproximatelyContained(
      { x: 0, y: 0, width: 100, height: 100, area: 10_000 },
      { x: 0, y: 0, width: 50, height: 50, area: 2_500 },
    ),
    false,
  );

  assert.equal(
    isApproximatelyContained(
      { x: 10, y: 10, width: 20, height: 20, area: 400 },
      { x: 0, y: 0, width: 100, height: 100, area: 10_000 },
    ),
    true,
  );
});

test("shouldMerge uses tight pixel threshold for entity wrappers", () => {
  const parent = node({ id: "p", width: 104, height: 44, isInteractive: false, paintOrder: 1 });
  const child = node({
    id: "c",
    x: 2,
    y: 2,
    width: 100,
    height: 40,
    isInteractive: true,
    paintOrder: 2,
    domParentId: "p",
  });

  assert.equal(shouldMerge(child, parent), true);
});

test("buildSpatialTree merges DOM twins and promotes ENTITY type", () => {
  const tree = buildSpatialTree([
    node({ id: "root", tagName: "div", width: 200, height: 100, paintOrder: 1 }),
    node({
      id: "button",
      tagName: "button",
      width: 198,
      height: 98,
      x: 1,
      y: 1,
      paintOrder: 2,
      domParentId: "root",
      isInteractive: true,
    }),
  ]);

  assert.equal(tree.length, 1);
  assert.equal(tree[0].type, "ENTITY");
  assert.deepEqual(new Set(tree[0].mergedDomIds), new Set(["root", "button"]));
});

test("fixed overlay is not swallowed by ordinary DOM parent", () => {
  const tree = buildSpatialTree([
    node({ id: "html", tagName: "html", width: 1000, height: 1000, paintOrder: 1 }),
    node({ id: "body", tagName: "body", width: 1000, height: 1000, paintOrder: 2, domParentId: "html" }),
    node({
      id: "modal",
      tagName: "div",
      x: 100,
      y: 100,
      width: 300,
      height: 200,
      paintOrder: 10,
      domParentId: "body",
      position: "fixed",
      zIndex: 1000,
    }),
  ]);

  assert.equal(tree.length, 2);
  assert.equal(tree.some((item) => item.id === "modal"), true);
});

test("truncateText compresses whitespace and caps text length", () => {
  assert.equal(truncateText("  hello\n\nworld  ", 80), "hello world");
  assert.equal(truncateText("abcdef", 4), "abc…");
});

function node(overrides: Partial<RawNode>): TreeNode {
  const width = overrides.width ?? 100;
  const height = overrides.height ?? 100;
  const raw: RawNode = {
    id: overrides.id ?? "n",
    backendNodeId: Number(overrides.backendNodeId ?? 1),
    tagName: overrides.tagName ?? "div",
    className: overrides.className ?? "",
    name: overrides.name ?? "",
    text: overrides.text ?? "",
    x: overrides.x ?? 0,
    y: overrides.y ?? 0,
    width,
    height,
    area: width * height,
    paintOrder: overrides.paintOrder ?? 1,
    domParentId: overrides.domParentId ?? null,
    position: overrides.position ?? "static",
    zIndex: overrides.zIndex,
    isVisible: overrides.isVisible ?? true,
    isInteractive: overrides.isInteractive ?? false,
    isScrollable: overrides.isScrollable ?? false,
  };

  return {
    ...raw,
    type: raw.isInteractive ? "ENTITY" : "ZONE",
    mergedDomIds: [raw.id],
    children: [],
  };
}
