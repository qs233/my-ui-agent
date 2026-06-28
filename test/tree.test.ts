import assert from "node:assert/strict";
import test from "node:test";
import { collapseDomTree } from "../src/compress.js";
import { computeOverlapRatios, isApproximatelyContained } from "../src/geometry.js";
import { serializeOverviewText } from "../src/serialize.js";
import { buildVisualContainmentTree } from "../src/tree.js";
import { truncateText } from "../src/text.js";
import type { DomNodeRecord, VctNode } from "../src/types.js";

test("overlap ratios distinguish full containment and approximate floating containment", () => {
  const full = computeOverlapRatios(
    { x: 10, y: 10, width: 20, height: 20, area: 400 },
    { x: 0, y: 0, width: 100, height: 100, area: 10_000 },
  );
  assert.equal(full.isFullyContained, true);
  assert.equal(full.childContainmentRatio, 1);
  assert.equal(full.parentOccupancyRatio, 0.04);

  const floating = computeOverlapRatios(
    { x: -1, y: 20, width: 80, height: 80, area: 6_400 },
    { x: 0, y: 0, width: 200, height: 200, area: 40_000 },
  );
  assert.equal(floating.isFullyContained, false);
  assert.equal(floating.childContainmentRatio > 0.8, true);
  assert.equal(floating.parentOccupancyRatio < 0.5, true);
});

test("isApproximatelyContained rejects larger children and high parent occupancy overflow", () => {
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

  assert.equal(
    isApproximatelyContained(
      { x: -1, y: 0, width: 100, height: 100, area: 10_000 },
      { x: 0, y: 0, width: 100, height: 100, area: 10_000 },
    ),
    false,
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
  assert.deepEqual(collapsed[0].collapsedDomNodeIds, ["wrapper"]);
  assert.equal(collapsed[0].ctParentId, null);
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
  assert.equal(collapsed.find((item) => item.id === "child")?.ctParentId, "wrapper");
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
  assert.equal(collapsed.find((item) => item.id === "child")?.ctParentId, "wrapper");
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

  assert.equal(collapsed.find((item) => item.id === "path")?.ctParentId, "svg");
  assert.equal(collapsed.find((item) => item.id === "button")?.ctParentId, "wrapper");
  assert.equal(collapsed.find((item) => item.id === "anchor-label")?.ctParentId, "anchor");
  assert.equal(collapsed.find((item) => item.id === "input")?.ctParentId, "form");
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
  assert.deepEqual(collapsed[0].collapsedDomNodeIds, ["outer", "inner"]);
  assert.equal(collapsed[0].x, 0);
  assert.equal(collapsed[0].width, 120);
});

test("buildVisualContainmentTree marks collapsed representatives", () => {
  const tree = buildVisualContainmentTree(collapseDomTree([
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
    node({ id: "sibling", tagName: "button", x: 200, width: 50, height: 30, paintOrder: 1 }),
  ]));

  const collapsedNode = tree.find((item) => item.id === "label");
  const plainNode = tree.find((item) => item.id === "sibling");
  assert.equal(collapsedNode?.isCollapsed, true);
  assert.deepEqual(collapsedNode?.collapsedDomNodeIds, ["outer", "inner"]);
  assert.equal(plainNode?.isCollapsed, false);
});

test("collapsed representatives inherit wrapper layout properties", () => {
  const collapsed = collapseDomTree([
    node({ id: "positioned-wrapper", width: 120, height: 60, position: "relative", zIndex: 10, paintOrder: 1 }),
    node({
      id: "label",
      tagName: "span",
      x: 10,
      y: 10,
      width: 80,
      height: 20,
      domParentId: "positioned-wrapper",
      paintOrder: 2,
    }),
  ]);

  assert.equal(collapsed[0].id, "label");
  assert.equal(collapsed[0].position, "relative");
  assert.equal(collapsed[0].zIndex, 10);
});

test("fixed or sticky nodes are preserved as collapse boundaries", () => {
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
    node({ id: "sticky", tagName: "div", x: 500, width: 100, height: 100, position: "sticky", paintOrder: 1 }),
    node({ id: "sticky-child", tagName: "span", x: 500, width: 100, height: 100, domParentId: "sticky", paintOrder: 2 }),
  ]);

  assert.equal(collapsed.some((item) => item.id === "body"), true);
  assert.equal(collapsed.find((item) => item.id === "modal")?.ctParentId, "body");
  assert.equal(collapsed.find((item) => item.id === "sticky-child")?.ctParentId, "sticky");
});

test("maybe scroll region nodes are preserved as collapse boundaries", () => {
  const collapsed = collapseDomTree([
    node({ id: "scroll-parent", tagName: "div", width: 100, height: 100, maybeScrollRegion: true, paintOrder: 1 }),
    node({ id: "child", tagName: "span", width: 100, height: 100, domParentId: "scroll-parent", paintOrder: 2 }),
    node({ id: "parent", tagName: "div", x: 200, width: 100, height: 100, paintOrder: 1 }),
    node({
      id: "scroll-child",
      tagName: "div",
      x: 200,
      width: 100,
      height: 100,
      domParentId: "parent",
      maybeScrollRegion: true,
      paintOrder: 2,
    }),
  ]);

  assert.equal(collapsed.find((item) => item.id === "child")?.ctParentId, "scroll-parent");
  assert.equal(collapsed.find((item) => item.id === "scroll-child")?.ctParentId, "parent");
});

test("maybe scroll region prevents descendants from reparenting outside its clip boundary", () => {
  const tree = buildOverviewTree([
    node({ id: "body", tagName: "body", width: 1000, height: 1000, paintOrder: 1 }),
    node({ id: "outside-card", tagName: "section", x: 0, y: 500, width: 200, height: 200, domParentId: "body", paintOrder: 2 }),
    node({
      id: "scroll-panel",
      tagName: "div",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      domParentId: "body",
      maybeScrollRegion: true,
      paintOrder: 2,
    }),
    node({
      id: "offscreen-item",
      tagName: "div",
      x: 10,
      y: 520,
      width: 60,
      height: 60,
      domParentId: "scroll-panel",
      paintOrder: 3,
    }),
  ]);

  const scrollPanel = findVctNode(tree, "scroll-panel");
  const outsideCard = findVctNode(tree, "outside-card");
  const offscreenItem = findVctNode(tree, "offscreen-item");

  assert.equal(offscreenItem?.vctParentId, scrollPanel?.vctId);
  assert.equal(offscreenItem?.isReparented, false);
  assert.equal(offscreenItem?.floating, true);
  assert.equal(outsideCard?.children.some((child) => child.id === "offscreen-item"), false);
});

test("maybe scroll region still allows reparenting within its clip boundary", () => {
  const tree = buildOverviewTree([
    node({ id: "body", tagName: "body", width: 1000, height: 1000, paintOrder: 1 }),
    node({
      id: "scroll-panel",
      tagName: "div",
      width: 300,
      height: 300,
      domParentId: "body",
      maybeScrollRegion: true,
      paintOrder: 2,
    }),
    node({ id: "section-a", tagName: "section", width: 20, height: 20, domParentId: "scroll-panel", paintOrder: 3 }),
    node({ id: "section-b", tagName: "section", x: 40, y: 40, width: 120, height: 120, domParentId: "scroll-panel", paintOrder: 3 }),
    node({
      id: "item",
      tagName: "div",
      x: 60,
      y: 60,
      width: 20,
      height: 20,
      domParentId: "section-a",
      paintOrder: 4,
    }),
  ]);

  const sectionB = findVctNode(tree, "section-b");
  const item = findVctNode(tree, "item");

  assert.equal(item?.vctParentId, sectionB?.vctId);
  assert.equal(item?.ctParentId, "section-a");
  assert.equal(item?.isReparented, true);
  assert.equal(item?.floating, false);
});

test("clip boundary keeps oversized scroll content as its child", () => {
  const tree = buildOverviewTree([
    node({ id: "body", tagName: "body", width: 1000, height: 1000, paintOrder: 1 }),
    node({
      id: "scroll-content",
      tagName: "ul",
      y: -200,
      width: 200,
      height: 1000,
      domParentId: "scroll-panel",
      paintOrder: 3,
    }),
    node({
      id: "scroll-panel",
      tagName: "div",
      width: 200,
      height: 200,
      domParentId: "body",
      position: "fixed",
      maybeScrollRegion: true,
      paintOrder: 2,
    }),
  ]);

  const scrollPanel = findVctNode(tree, "scroll-panel");
  const scrollContent = findVctNode(tree, "scroll-content");

  assert.equal(scrollContent?.vctParentId, scrollPanel?.vctId);
  assert.equal(scrollContent?.ctParentId, "scroll-panel");
  assert.equal(scrollContent?.isReparented, false);
  assert.equal(scrollContent?.floating, true);
  assert.equal(tree.some((root) => root.id === "scroll-content"), false);
});

test("buildVisualContainmentTree uses approximate containment for visual parents", () => {
  const tree = buildVisualContainmentTree(collapseDomTree([
    node({ id: "parent", tagName: "section", width: 200, height: 200, paintOrder: 1 }),
    node({ id: "child", tagName: "div", x: -1, y: 20, width: 80, height: 80, paintOrder: 2 }),
  ]));

  assert.equal(tree.length, 1);
  assert.equal(tree[0].id, "parent");
  assert.equal(tree[0].children[0]?.id, "child");
  assert.equal(tree[0].vctId, 1);
  assert.equal(tree[0].children[0]?.vctParentId, 1);
  assert.equal(tree[0].children[0]?.floating, true);
  assert.equal(tree[0].children[0]?.isReparented, true);
});

test("serializeOverviewText writes reparent source as dom_parent_id", () => {
  const tree = buildVisualContainmentTree(collapseDomTree([
    node({ id: "body", tagName: "body", width: 300, height: 300, paintOrder: 1 }),
    node({ id: "container", tagName: "div", width: 200, height: 200, domParentId: "body", paintOrder: 2 }),
    node({ id: "spacer", tagName: "div", x: 240, y: 0, width: 20, height: 20, domParentId: "body", paintOrder: 2 }),
    node({
      id: "floating",
      tagName: "div",
      x: 10,
      y: 10,
      width: 60,
      height: 60,
      domParentId: "container",
      position: "fixed",
      zIndex: 10,
      paintOrder: 3,
    }),
  ]));

  const text = serializeOverviewText(tree);
  assert.match(text, /\breparented\b.*\bdom_parent_id=2\b/);
  assert.doesNotMatch(text, /\bparent_id=/);
});

test("serializeOverviewText marks expandable collapsed nodes", () => {
  const tree = buildVisualContainmentTree(collapseDomTree([
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
    node({ id: "button", tagName: "button", x: 200, width: 80, height: 30, paintOrder: 1 }),
  ]));

  const text = serializeOverviewText(tree);
  assert.match(text, /\[\d+\] LEAF span .*text="Account settings".*collapsed/);
  assert.doesNotMatch(text, /\[\d+\] LEAF button .*collapsed/);
});

test("buildVisualContainmentTree keeps DOM parent metadata separate from VCT parent metadata", () => {
  const tree = buildOverviewTree([
    node({ id: "parent", tagName: "section", width: 200, height: 200, paintOrder: 1 }),
    node({
      id: "child",
      tagName: "input",
      x: 20,
      y: 20,
      width: 80,
      height: 80,
      domParentId: "parent",
      paintOrder: 2,
    }),
  ]);

  const child = tree[0].children[0];
  assert.equal(tree[0].vctId, 1);
  assert.equal(child?.vctId, 2);
  assert.equal(child?.vctParentId, 1);
  assert.equal(child?.ctParentId, "parent");
  assert.equal(child?.isReparented, false);
  assert.equal(child?.floating, false);
});

test("positive z-index alone does not force reparenting", () => {
  const tree = buildOverviewTree([
    node({ id: "body", tagName: "body", width: 500, height: 300, paintOrder: 1 }),
    node({ id: "container", tagName: "div", width: 300, height: 200, domParentId: "body", paintOrder: 2 }),
    node({ id: "sibling", tagName: "div", x: 350, width: 50, height: 50, domParentId: "body", paintOrder: 2 }),
    node({
      id: "raised",
      tagName: "div",
      x: 10,
      y: 10,
      width: 100,
      height: 50,
      domParentId: "container",
      position: "relative",
      zIndex: 3,
      paintOrder: 3,
    }),
    node({ id: "extra", tagName: "div", x: 10, y: 80, width: 10, height: 10, domParentId: "container", paintOrder: 3 }),
  ]);

  const container = tree[0].children.find((item) => item.id === "container");
  const raised = container?.children.find((item) => item.id === "raised");
  assert.equal(raised?.isReparented, false);
  assert.equal(raised?.floating, false);
  assert.equal(raised?.vctParentId, container?.vctId);
});

test("buildVisualContainmentTree does not align without an alignment resolver", () => {
  const tree = buildVisualContainmentTree(collapseDomTree([
    node({ id: "body", tagName: "body", width: 300, height: 300, paintOrder: 1 }),
    node({ id: "input", tagName: "input", width: 100, height: 20, domParentId: "body", paintOrder: 2 }),
    node({
      id: "menu",
      tagName: "div",
      y: 20,
      width: 100,
      height: 80,
      domParentId: "body",
      position: "fixed",
      zIndex: 10,
      paintOrder: 3,
    }),
  ]));

  const body = tree.find((item) => item.id === "body");
  const input = body?.children.find((item) => item.id === "input");
  const menu = tree.find((item) => item.id === "menu");
  assert.equal(input?.isReparented, false);
  assert.equal(input?.alignToId, undefined);
  assert.equal(menu?.isReparented, true);
  assert.equal(menu?.alignToId, undefined);
});

test("explicit alignment resolver only runs for reparented nodes", () => {
  const resolvedNodeIds: string[] = [];
  const tree = buildVisualContainmentTree(collapseDomTree([
    node({ id: "body", tagName: "body", width: 300, height: 300, paintOrder: 1 }),
    node({ id: "input", tagName: "input", width: 100, height: 20, domParentId: "body", paintOrder: 2 }),
    node({
      id: "menu",
      tagName: "div",
      y: 20,
      width: 100,
      height: 80,
      domParentId: "body",
      position: "fixed",
      zIndex: 10,
      paintOrder: 3,
    }),
  ]), {
    alignmentResolver: (nodeToAlign, context) => {
      resolvedNodeIds.push(nodeToAlign.id);
      return context.candidates[0];
    },
  });

  const body = tree.find((item) => item.id === "body");
  const input = body?.children.find((item) => item.id === "input");
  const menu = tree.find((item) => item.id === "menu");
  assert.deepEqual(resolvedNodeIds, ["menu"]);
  assert.equal(input?.alignToId, undefined);
  assert.equal(menu?.alignToId, input?.vctId);
});

test("alignment resolver receives at most five local candidates", () => {
  let candidateIds: string[] = [];

  buildVisualContainmentTree(collapseDomTree([
    node({ id: "body", tagName: "body", width: 500, height: 500, paintOrder: 1 }),
    node({ id: "field-1", tagName: "input", x: 0, y: 0, width: 100, height: 20, domParentId: "body", paintOrder: 2 }),
    node({ id: "field-2", tagName: "input", x: 0, y: 20, width: 100, height: 20, domParentId: "body", paintOrder: 2 }),
    node({ id: "field-3", tagName: "input", x: 0, y: 40, width: 100, height: 20, domParentId: "body", paintOrder: 2 }),
    node({ id: "field-4", tagName: "input", x: 0, y: 60, width: 100, height: 20, domParentId: "body", paintOrder: 2 }),
    node({ id: "field-5", tagName: "input", x: 0, y: 80, width: 100, height: 20, domParentId: "body", paintOrder: 2 }),
    node({ id: "field-6", tagName: "input", x: 0, y: 100, width: 100, height: 20, domParentId: "body", paintOrder: 2 }),
    node({
      id: "menu",
      tagName: "div",
      x: 0,
      y: 120,
      width: 100,
      height: 80,
      domParentId: "body",
      position: "fixed",
      zIndex: 10,
      paintOrder: 3,
    }),
  ]), {
    alignmentResolver: (_node, context) => {
      candidateIds = context.candidates.map((candidate) => candidate.id);
      return undefined;
    },
  });

  assert.equal(candidateIds.length, 5);
  assert.equal(candidateIds.includes("field-6"), true);
});

test("alignment candidates are limited to direct children of the collapsed tree parent", () => {
  let candidateIds: string[] = [];

  buildVisualContainmentTree(collapseDomTree([
    node({ id: "body", tagName: "body", width: 500, height: 500, paintOrder: 1 }),
    node({ id: "near-target", tagName: "input", x: 0, y: 0, width: 100, height: 20, domParentId: "body", paintOrder: 2 }),
    node({ id: "container", tagName: "section", x: 200, y: 0, width: 200, height: 120, domParentId: "body", paintOrder: 2 }),
    node({
      id: "nested-target",
      tagName: "input",
      x: 200,
      y: 20,
      width: 100,
      height: 20,
      domParentId: "container",
      paintOrder: 3,
    }),
    node({
      id: "menu",
      tagName: "div",
      x: 0,
      y: 20,
      width: 100,
      height: 80,
      domParentId: "body",
      position: "fixed",
      zIndex: 10,
      paintOrder: 4,
    }),
  ]), {
    alignmentResolver: (_node, context) => {
      candidateIds = context.candidates.map((candidate) => candidate.id);
      return undefined;
    },
  });

  assert.equal(candidateIds.includes("near-target"), true);
  assert.equal(candidateIds.includes("nested-target"), false);
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

type NodeOverrides = Partial<DomNodeRecord> & { domParentId?: string | null };

function node(overrides: NodeOverrides): DomNodeRecord {
  const width = overrides.width ?? 100;
  const height = overrides.height ?? 100;
  const bounds = {
    x: overrides.x ?? 0,
    y: overrides.y ?? 0,
    width,
    height,
    area: overrides.area ?? width * height,
  };
  const raw: DomNodeRecord = {
    id: overrides.id ?? "n",
    parentId: overrides.parentId ?? overrides.domParentId ?? null,
    childIds: [...(overrides.childIds ?? [])],
    bounds,
    tagName: overrides.tagName ?? "div",
    className: overrides.className ?? "",
    name: overrides.name ?? "",
    text: overrides.text ?? "",
    x: bounds.x,
    y: bounds.y,
    width,
    height,
    area: bounds.area,
    paintOrder: overrides.paintOrder ?? 1,
    position: overrides.position ?? "static",
    zIndex: overrides.zIndex,
    isInteractive: overrides.isInteractive ?? false,
    maybeScrollRegion: overrides.maybeScrollRegion ?? false,
  };

  return raw;
}

function buildOverviewTree(rawNodes: DomNodeRecord[]): VctNode[] {
  return buildVisualContainmentTree(collapseDomTree(rawNodes));
}

function findVctNode(nodes: VctNode[], id: string): VctNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const child = findVctNode(node.children, id);
    if (child) return child;
  }
  return undefined;
}

function leafType(node: unknown): "LEAF" | undefined {
  if (typeof node === "object" && node !== null && "type" in node && node.type === "LEAF") return "LEAF";
  return undefined;
}
