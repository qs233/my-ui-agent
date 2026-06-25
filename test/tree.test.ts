import assert from "node:assert/strict";
import test from "node:test";
import { compressDomTree } from "../src/compress.js";
import { isApproximatelyContained, shouldMerge } from "../src/geometry.js";
import { buildSpatialTree } from "../src/tree.js";
import { truncateText } from "../src/text.js";
import type { CompressedNode, RawNode, TreeNode } from "../src/types.js";

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
  const parent = zoneNode(node({ id: "p", width: 104, height: 44, paintOrder: 1 }));
  const childRaw = node({
    id: "c",
    x: 2,
    y: 2,
    width: 100,
    height: 40,
    isInteractive: true,
    paintOrder: 2,
    domParentId: "p",
  });
  const child: CompressedNode = {
    ...childRaw,
    type: "ENTITY",
    entityKind: "interactive",
    semanticBounds: boundsFromRaw(childRaw),
    mergedDomIds: [childRaw.id],
  };

  assert.equal(shouldMerge(child, parent), true);
});

test("buildSpatialTree keeps the semantic entity as the representative", () => {
  const tree = buildOverviewTree([
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
  assert.equal(tree[0].id, "button");
  assert.equal(tree[0].tagName, "button");
  assert.equal(tree[0].width, 200);
  assert.equal(tree[0].semanticBounds.width, 198);
  assert.deepEqual(new Set(tree[0].mergedDomIds), new Set(["root", "button"]));
});

test("text nodes become text entities and keep their original tag", () => {
  const tree = buildOverviewTree([
    node({ id: "wrapper", width: 104, height: 44 }),
    node({
      id: "heading",
      tagName: "h2",
      text: "Account settings",
      x: 2,
      y: 2,
      width: 100,
      height: 40,
      domParentId: "wrapper",
      paintOrder: 2,
    }),
  ]);

  assert.equal(tree.length, 1);
  assert.equal(tree[0].type, "ENTITY");
  assert.equal(tree[0].entityKind, "text");
  assert.equal(tree[0].tagName, "h2");
  assert.equal(tree[0].text, "Account settings");
});

test("interactive entities absorb descendant text entities", () => {
  const tree = buildOverviewTree([
    node({ id: "button", tagName: "button", width: 120, height: 40, isInteractive: true }),
    node({
      id: "label",
      tagName: "span",
      text: "Save changes",
      x: 10,
      y: 10,
      width: 90,
      height: 20,
      domParentId: "button",
      paintOrder: 2,
    }),
  ]);

  assert.equal(tree.length, 1);
  assert.equal(tree[0].type, "ENTITY");
  assert.equal(tree[0].entityKind, "interactive");
  assert.equal(tree[0].tagName, "button");
  assert.equal(tree[0].text, "Save changes");
  assert.deepEqual(new Set(tree[0].mergedDomIds), new Set(["button", "label"]));
});

test("a sibling prevents a wrapper from collapsing into its entity", () => {
  const tree = buildOverviewTree([
    node({ id: "wrapper", width: 200, height: 100 }),
    node({
      id: "button",
      tagName: "button",
      width: 198,
      height: 98,
      x: 1,
      y: 1,
      domParentId: "wrapper",
      isInteractive: true,
      paintOrder: 2,
    }),
    node({
      id: "decoration",
      width: 20,
      height: 20,
      x: 10,
      y: 10,
      domParentId: "wrapper",
      paintOrder: 2,
    }),
  ]);

  assert.equal(tree[0].id, "wrapper");
  const button = findNode(tree, "button");
  assert.ok(button);
  assert.deepEqual(button.mergedDomIds, ["button"]);
});

test("preserved tags are not collapsed into their only semantic child", () => {
  const tree = buildOverviewTree([
    node({ id: "svg", tagName: "svg", width: 100, height: 100, paintOrder: 1 }),
    node({
      id: "path",
      tagName: "path",
      width: 100,
      height: 100,
      domParentId: "svg",
      paintOrder: 2,
    }),
  ]);

  assert.equal(tree.length, 1);
  assert.equal(tree[0].id, "svg");
  assert.equal(tree[0].type, "ZONE");
  assert.equal(tree[0].children[0]?.id, "path");
  assert.equal(tree[0].children[0]?.type, "LEAF");
});

test("ordinary wrappers do not collapse preserved zone children", () => {
  const compressed = compressDomTree([
    node({ id: "wrapper", tagName: "div", width: 100, height: 100, paintOrder: 1 }),
    node({
      id: "svg",
      tagName: "svg",
      width: 100,
      height: 100,
      domParentId: "wrapper",
      paintOrder: 2,
    }),
    node({
      id: "path",
      tagName: "path",
      width: 50,
      height: 50,
      x: 25,
      y: 25,
      domParentId: "svg",
      paintOrder: 3,
    }),
  ]);

  assert.equal(compressed.some((item) => item.id === "svg"), true);
  assert.equal(compressed.find((item) => item.id === "svg")?.domParentId, "wrapper");
  assert.equal(compressed.find((item) => item.id === "path")?.domParentId, "svg");
});

test("form and anchor boundaries survive single-child compression", () => {
  const compressed = compressDomTree([
    node({ id: "form", tagName: "form", width: 100, height: 40, paintOrder: 1 }),
    node({
      id: "input",
      tagName: "input",
      width: 100,
      height: 40,
      domParentId: "form",
      isInteractive: true,
      paintOrder: 2,
    }),
    node({ id: "anchor", tagName: "a", x: 200, width: 100, height: 40, paintOrder: 1 }),
    node({
      id: "label",
      tagName: "span",
      text: "Settings",
      x: 200,
      width: 100,
      height: 40,
      domParentId: "anchor",
      paintOrder: 2,
    }),
  ]);

  assert.equal(compressed.find((item) => item.id === "form")?.type, "ZONE");
  assert.equal(compressed.find((item) => item.id === "input")?.domParentId, "form");
  assert.equal(compressed.find((item) => item.id === "anchor")?.type, "ZONE");
  assert.equal(compressed.find((item) => item.id === "label")?.domParentId, "anchor");
});

test("a merged layout boundary prevents further ancestor collapse", () => {
  const tree = buildOverviewTree([
    node({ id: "outer", width: 108, height: 48 }),
    node({
      id: "fixed-wrapper",
      x: 2,
      y: 2,
      width: 104,
      height: 44,
      domParentId: "outer",
      position: "fixed",
      zIndex: 10,
      paintOrder: 2,
    }),
    node({
      id: "button",
      tagName: "button",
      x: 4,
      y: 4,
      width: 100,
      height: 40,
      domParentId: "fixed-wrapper",
      isInteractive: true,
      paintOrder: 3,
    }),
  ]);

  const button = findNode(tree, "button");
  assert.ok(button);
  assert.equal(button.type, "ENTITY");
  assert.equal(button.width, 104);
  assert.equal(button.semanticBounds.width, 100);
  assert.equal(button.position, "fixed");
  assert.equal(button.zIndex, 10);
  assert.equal(button.mergedDomIds.includes("fixed-wrapper"), true);
  assert.equal(button.mergedDomIds.includes("outer"), false);
});

test("compressDomTree rewrites parent IDs to surviving representatives", () => {
  const compressed = compressDomTree([
    node({ id: "outer", width: 300, height: 200 }),
    node({ id: "wrapper", x: 20, y: 20, width: 104, height: 44, domParentId: "outer" }),
    node({
      id: "button",
      tagName: "button",
      x: 22,
      y: 22,
      width: 100,
      height: 40,
      domParentId: "wrapper",
      isInteractive: true,
      paintOrder: 2,
    }),
  ]);

  assert.equal(compressed.some((item) => item.id === "wrapper"), false);
  assert.equal(compressed.find((item) => item.id === "button")?.domParentId, "outer");
});

test("buildSpatialTree allows contained parent and child to share paint order", () => {
  const tree = buildOverviewTree([
    node({ id: "parent", width: 200, height: 200, paintOrder: 1 }),
    node({
      id: "child",
      x: 20,
      y: 20,
      width: 80,
      height: 80,
      paintOrder: 1,
      domParentId: "parent",
    }),
  ]);

  assert.equal(tree.length, 1);
  assert.equal(tree[0].id, "parent");
  assert.equal(tree[0].children[0]?.id, "child");
});

test("fixed overlay is not swallowed by ordinary DOM parent", () => {
  const tree = buildOverviewTree([
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

function node(overrides: Partial<RawNode>): RawNode {
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
    isInteractive: overrides.isInteractive ?? false,
    isScrollable: overrides.isScrollable ?? false,
  };

  return raw;
}

function buildOverviewTree(rawNodes: RawNode[]): TreeNode[] {
  return buildSpatialTree(compressDomTree(rawNodes));
}

function zoneNode(raw: RawNode): CompressedNode {
  return { ...raw, type: "ZONE", mergedDomIds: [raw.id] };
}

function boundsFromRaw(raw: RawNode) {
  return { x: raw.x, y: raw.y, width: raw.width, height: raw.height, area: raw.area };
}

function findNode(nodes: TreeNode[], id: string): TreeNode | undefined {
  for (const current of nodes) {
    if (current.id === id) return current;
    const nested = findNode(current.children, id);
    if (nested) return nested;
  }
  return undefined;
}
