import assert from "node:assert/strict";
import test from "node:test";
import { collapseDomTree } from "../src/compress.js";
import { isApproximatelyContained } from "../src/geometry.js";
import { buildVisualContainmentTree } from "../src/tree.js";
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

test("collapseDomTree collapses a fully containing single-child wrapper", () => {
  const collapsed = collapseDomTree([
    node({ id: "wrapper", tagName: "div", width: 120, height: 60, paintOrder: 1 }),
    node({
      id: "label",
      tagName: "span",
      text: "Account settings",
      x: 10,
      y: 10,
      width: 80,
      height: 20,
      domParentId: "wrapper",
      paintOrder: 2,
    }),
  ]);

  assert.equal(collapsed.length, 1);
  assert.equal(collapsed[0].id, "label");
  assert.equal(collapsed[0].tagName, "span");
  assert.equal(leafType(collapsed[0]), "LEAF");
  assert.deepEqual(collapsed[0].wrapperDomIds, ["wrapper"]);
  assert.equal(collapsed[0].domParentId, null);
  assert.equal(collapsed[0].x, 0);
  assert.equal(collapsed[0].width, 120);
  assert.equal(collapsed[0].text, "Account settings");
});

test("collapseDomTree does not collapse approximate-only containment", () => {
  const collapsed = collapseDomTree([
    node({ id: "wrapper", tagName: "div", width: 100, height: 100, paintOrder: 1 }),
    node({
      id: "child",
      tagName: "span",
      x: -1,
      width: 100,
      height: 100,
      domParentId: "wrapper",
      paintOrder: 2,
    }),
  ]);

  assert.equal(collapsed.some((item) => item.id === "wrapper"), true);
  assert.equal(collapsed.find((item) => item.id === "child")?.domParentId, "wrapper");
});

test("collapseDomTree requires parent paint order before or equal to child", () => {
  const collapsed = collapseDomTree([
    node({ id: "wrapper", tagName: "div", width: 100, height: 100, paintOrder: 3 }),
    node({
      id: "child",
      tagName: "span",
      width: 100,
      height: 100,
      domParentId: "wrapper",
      paintOrder: 2,
    }),
  ]);

  assert.equal(collapsed.some((item) => item.id === "wrapper"), true);
  assert.equal(collapsed.find((item) => item.id === "child")?.domParentId, "wrapper");
});

test("preserved tags block collapse as parent or child", () => {
  const collapsed = collapseDomTree([
    node({ id: "svg", tagName: "svg", width: 100, height: 100, paintOrder: 1 }),
    node({ id: "path", tagName: "path", width: 100, height: 100, domParentId: "svg", paintOrder: 2 }),
    node({ id: "wrapper", tagName: "div", x: 200, width: 100, height: 40, paintOrder: 1 }),
    node({
      id: "button",
      tagName: "button",
      x: 200,
      width: 100,
      height: 40,
      domParentId: "wrapper",
      isInteractive: true,
      paintOrder: 2,
    }),
    node({ id: "anchor", tagName: "a", x: 400, width: 100, height: 40, paintOrder: 1 }),
    node({
      id: "anchor-label",
      tagName: "span",
      text: "Settings",
      x: 400,
      width: 100,
      height: 40,
      domParentId: "anchor",
      paintOrder: 2,
    }),
    node({ id: "form", tagName: "form", x: 600, width: 100, height: 40, paintOrder: 1 }),
    node({
      id: "input",
      tagName: "input",
      x: 600,
      width: 100,
      height: 40,
      domParentId: "form",
      isInteractive: true,
      paintOrder: 2,
    }),
  ]);

  assert.equal(collapsed.find((item) => item.id === "path")?.domParentId, "svg");
  assert.equal(collapsed.find((item) => item.id === "button")?.domParentId, "wrapper");
  assert.equal(collapsed.find((item) => item.id === "anchor-label")?.domParentId, "anchor");
  assert.equal(collapsed.find((item) => item.id === "input")?.domParentId, "form");
});

test("collapsed wrapper IDs are outer-to-inner and exclude the representative node", () => {
  const collapsed = collapseDomTree([
    node({ id: "outer", tagName: "div", width: 120, height: 60, paintOrder: 1 }),
    node({
      id: "inner",
      tagName: "div",
      x: 10,
      y: 10,
      width: 90,
      height: 30,
      domParentId: "outer",
      paintOrder: 2,
    }),
    node({
      id: "label",
      tagName: "span",
      x: 20,
      y: 15,
      width: 60,
      height: 20,
      domParentId: "inner",
      paintOrder: 3,
    }),
  ]);

  assert.equal(collapsed.length, 1);
  assert.equal(collapsed[0].id, "label");
  assert.deepEqual(collapsed[0].wrapperDomIds, ["outer", "inner"]);
  assert.equal(collapsed[0].x, 0);
  assert.equal(collapsed[0].width, 120);
});

test("collapsed representatives inherit wrapper layout properties", () => {
  const collapsed = collapseDomTree([
    node({ id: "fixed-wrapper", width: 120, height: 60, position: "fixed", zIndex: 10, paintOrder: 1 }),
    node({
      id: "label",
      tagName: "span",
      x: 10,
      y: 10,
      width: 80,
      height: 20,
      domParentId: "fixed-wrapper",
      paintOrder: 2,
    }),
  ]);

  assert.equal(collapsed[0].id, "label");
  assert.equal(collapsed[0].position, "fixed");
  assert.equal(collapsed[0].zIndex, 10);
});

test("ordinary wrappers do not collapse floating children", () => {
  const collapsed = collapseDomTree([
    node({ id: "body", tagName: "body", width: 1000, height: 1000, paintOrder: 1 }),
    node({
      id: "modal",
      tagName: "div",
      x: 100,
      y: 100,
      width: 300,
      height: 200,
      domParentId: "body",
      position: "fixed",
      zIndex: 1000,
      paintOrder: 2,
    }),
  ]);

  assert.equal(collapsed.some((item) => item.id === "body"), true);
  assert.equal(collapsed.find((item) => item.id === "modal")?.domParentId, "body");
});

test("buildVisualContainmentTree uses approximate containment for visual parents", () => {
  const tree = buildVisualContainmentTree(collapseDomTree([
    node({ id: "parent", tagName: "section", width: 200, height: 200, paintOrder: 1 }),
    node({ id: "child", tagName: "div", x: -1, y: 20, width: 80, height: 80, paintOrder: 2 }),
  ]));

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
  return buildVisualContainmentTree(collapseDomTree(rawNodes));
}

function leafType(node: unknown): "LEAF" | undefined {
  if (typeof node === "object" && node !== null && "type" in node && node.type === "LEAF") return "LEAF";
  return undefined;
}
