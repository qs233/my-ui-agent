import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright";
import { collapseDomTree } from "../src/compress.js";
import { intersectsExpandedViewport } from "../src/geometry.js";
import { captureVisibleNodes } from "../src/index.js";
import { visibleNodesFromSnapshot } from "../src/prepare.js";
import { prepareNodes } from "./decoded-helpers.js";
import type { DecodedLayoutElement, DecodedLayoutNode, DecodedLayoutText } from "./decoded-helpers.js";
import type { Bounds, SnapshotResponse } from "../src/types.js";

test("prepareNodes filters rendered visibility and rewrites retained parents", () => {
  const decoded: DecodedLayoutNode[] = [
    element(1, null, { width: 400, height: 300 }),
    element(2, 1, { width: 0, height: 0 }),
    element(3, 2, { x: 20, y: 20, width: 100, height: 40 }),
    element(4, 1, { styles: styleMap({ visibility: "hidden" }) }),
    element(5, 1, { styles: styleMap({ opacity: "0" }) }),
    element(6, 5),
    element(7, 1, { styles: styleMap({ "content-visibility": "hidden" }) }),
    element(8, 7),
  ];

  const raw = prepareNodes(decoded);
  assert.deepEqual(raw.map((node) => node.id), ["1", "3"]);
  assert.equal(raw.find((node) => node.id === "3")?.parentId, "1");
  assert.equal("backendNodeId" in raw[0], false);
});

test("prepareNodes assigns and joins usable layout text after filtering", () => {
  const decoded: DecodedLayoutNode[] = [
    element(1, null),
    element(2, 1, { tagName: "h2" }),
    text(3, 2, "  Account "),
    text(4, 2, "settings  ", { x: 80 }),
    text(5, 2, "   "),
    text(6, 2, "ignored", { width: 0 }),
  ];

  const raw = prepareNodes(decoded);
  assert.equal(raw.find((node) => node.id === "2")?.text, "Account settings");
});

test("prepareNodes marks maybe scroll regions from overflow styles", () => {
  const raw = prepareNodes([
    element(1, null, { styles: styleMap({ overflow: "auto" }) }),
    element(2, 1, { styles: styleMap({ "overflow-x": "scroll" }) }),
    element(3, 1, { styles: styleMap({ "overflow-y": "hidden" }) }),
    element(4, 1, { styles: styleMap({ overflow: "visible" }) }),
  ]);

  assert.equal(raw.find((node) => node.id === "1")?.maybeScrollRegion, true);
  assert.equal(raw.find((node) => node.id === "2")?.maybeScrollRegion, true);
  assert.equal(raw.find((node) => node.id === "3")?.maybeScrollRegion, true);
  assert.equal(raw.find((node) => node.id === "4")?.maybeScrollRegion, false);
});

test("prepareNodes assigns overflow scope metadata", () => {
  const raw = prepareNodes([
    element(1, null),
    element(2, 1, { styles: styleMap({ overflow: "auto" }) }),
    element(3, 2),
  ]);

  assert.equal(raw.find((node) => node.id === "1")?.boxOverflowScopeId, "viewport");
  assert.equal(raw.find((node) => node.id === "2")?.boxOverflowScopeId, "viewport");
  assert.equal(raw.find((node) => node.id === "2")?.ownedOverflowScopeId, "overflow:2");
  assert.equal(raw.find((node) => node.id === "3")?.boxOverflowScopeId, "overflow:2");
});

test("prepareNodes retains hidden positive overflow owners as invisible overflow boundaries", () => {
  const raw = prepareNodes([
    element(1, null),
    element(2, 1, { styles: styleMap({ overflow: "auto", visibility: "hidden" }) }),
    element(3, 2, { styles: styleMap({ visibility: "visible" }) }),
    text(4, 3, "Visible child"),
  ]);

  assert.deepEqual(raw.map((node) => node.id), ["1", "2", "3"]);
  const owner = raw.find((node) => node.id === "2");
  assert.equal(owner?.isVisible, false);
  assert.equal(owner?.isInvisibleOverflowBoundary, true);
  assert.equal(owner?.ownedOverflowScopeId, "overflow:2");
  assert.equal(raw.find((node) => node.id === "3")?.parentId, "2");
  assert.equal(raw.find((node) => node.id === "3")?.boxOverflowScopeId, "overflow:2");
  assert.equal(raw.find((node) => node.id === "3")?.text, "Visible child");
});

test("prepareNodes does not retain hidden overflow owners without visible owned-scope descendants", () => {
  const raw = prepareNodes([
    element(1, null),
    element(2, 1, { styles: styleMap({ overflow: "auto", visibility: "hidden" }) }),
  ]);

  assert.deepEqual(raw.map((node) => node.id), ["1"]);
});

test("prepareNodes does not retain zero-size hidden overflow owners", () => {
  const raw = prepareNodes([
    element(1, null),
    element(2, 1, { width: 0, height: 0, styles: styleMap({ overflow: "auto", visibility: "hidden" }) }),
    element(3, 2, { styles: styleMap({ visibility: "visible" }) }),
  ]);

  assert.deepEqual(raw.map((node) => node.id), ["1"]);
});

test("prepareNodes resolves absolute overflow scope from containing block", () => {
  const outsideCb = prepareNodes([
    element(1, null),
    element(2, 1, { styles: styleMap({ position: "relative" }) }),
    element(3, 2, { styles: styleMap({ overflow: "auto" }) }),
    element(4, 3, { styles: styleMap({ position: "absolute" }) }),
  ]);
  assert.equal(outsideCb.find((node) => node.id === "4")?.boxOverflowScopeId, "viewport");

  const ownerCb = prepareNodes([
    element(1, null),
    element(2, 1, { styles: styleMap({ overflow: "auto", position: "relative" }) }),
    element(3, 2, { styles: styleMap({ position: "absolute" }) }),
  ]);
  assert.equal(ownerCb.find((node) => node.id === "3")?.boxOverflowScopeId, "overflow:2");
});

test("prepareNodes resolves fixed overflow scope from transform containing block", () => {
  const viewportFixed = prepareNodes([
    element(1, null),
    element(2, 1, { styles: styleMap({ overflow: "auto" }) }),
    element(3, 2, { styles: styleMap({ position: "fixed" }) }),
  ]);
  assert.equal(viewportFixed.find((node) => node.id === "3")?.boxOverflowScopeId, "viewport");

  const transformedFixed = prepareNodes([
    element(1, null),
    element(2, 1, { styles: styleMap({ overflow: "auto" }) }),
    element(3, 2, { styles: styleMap({ transform: "translateX(0)" }) }),
    element(4, 3, { styles: styleMap({ position: "fixed" }) }),
  ]);
  assert.equal(transformedFixed.find((node) => node.id === "4")?.boxOverflowScopeId, "overflow:2");
});

test("visibleNodesFromSnapshot prepares retained nodes directly from snapshot", () => {
  const strings = [
    "",
    "#document",
    "HTML",
    "BODY",
    "DIV",
    "SPAN",
    "BUTTON",
    "#text",
    "Submit",
    "Generated",
    "Hidden",
    "::before",
    "block",
    "visible",
    "1",
    "static",
    "auto",
    "0",
    "hidden",
    "class",
    "cta",
  ];
  const visibleStyles = [12, 13, 14, 13, 15, 16, 13, 13, 13, 16, 16];
  const transparentStyles = [12, 13, 17, 13, 15, 16, 13, 13, 13, 16, 16];
  const hiddenStyles = [12, 18, 14, 13, 15, 16, 13, 13, 13, 16, 16];
  const snapshot: SnapshotResponse = {
    strings,
    documents: [{
      nodes: {
        parentIndex: [-1, 0, 1, 2, 3, 4, 5, 3, 7, 3, 9, 5, 11],
        nodeType: [9, 1, 1, 1, 1, 1, 3, 1, 1, 1, 3, 1, 3],
        nodeName: [1, 2, 3, 4, 5, 6, 7, 4, 6, 4, 7, 11, 7],
        backendNodeId: [0, 1, 2, 3, 4, 5, 0, 7, 8, 9, 0, 11, 0],
        attributes: [[], [], [], [], [], [19, 20], [], [], [], [], [], [], []],
        pseudoType: { index: [11], value: [0] },
      },
      layout: {
        nodeIndex: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
        bounds: [
          rect(0, 0, 400, 300),
          rect(0, 0, 400, 300),
          rect(0, 0, 400, 300),
          rect(0, 0, 0, 0),
          rect(20, 20, 120, 30),
          rect(25, 25, 60, 20),
          rect(0, 60, 120, 30),
          rect(0, 60, 80, 20),
          rect(0, 100, 120, 30),
          rect(5, 105, 60, 20),
          rect(20, 20, 70, 20),
          rect(20, 20, 70, 20),
        ],
        text: [0, 0, 0, 0, 0, 8, 0, 0, 0, 10, 0, 9],
        styles: [
          visibleStyles,
          visibleStyles,
          visibleStyles,
          visibleStyles,
          visibleStyles,
          [],
          transparentStyles,
          visibleStyles,
          hiddenStyles,
          [],
          visibleStyles,
          [],
        ],
        paintOrders: [1, 1, 1, 1, 2, 3, 2, 3, 2, 3, 3, 3],
      },
    }],
  };

  const raw = visibleNodesFromSnapshot(snapshot);
  assert.deepEqual(raw.map((node) => node.id), ["1", "2", "3", "5"]);
  assert.equal(raw.find((node) => node.id === "5")?.parentId, "3");
  assert.equal(raw.find((node) => node.id === "5")?.text, "Submit Generated");
});

test("visibleNodesFromSnapshot retains hidden invisible overflow boundaries", () => {
  const strings = [
    "",
    "#document",
    "HTML",
    "BODY",
    "DIV",
    "#text",
    "Visible child",
    "block",
    "visible",
    "hidden",
    "1",
    "static",
    "auto",
  ];
  const visibleStyles = [7, 8, 10, 8, 11, 12, 8, 8, 8, 12, 12];
  const hiddenOverflowStyles = [7, 9, 10, 8, 11, 12, 12, 12, 12, 12, 12];
  const snapshot: SnapshotResponse = {
    strings,
    documents: [{
      nodes: {
        parentIndex: [-1, 0, 1, 2, 3, 4],
        nodeType: [9, 1, 1, 1, 1, 3],
        nodeName: [1, 2, 3, 4, 4, 5],
        backendNodeId: [0, 1, 2, 3, 4, 0],
        attributes: [[], [], [], [], [], []],
      },
      layout: {
        nodeIndex: [1, 2, 3, 4, 5],
        bounds: [
          rect(0, 0, 400, 300),
          rect(0, 0, 400, 300),
          rect(10, 10, 200, 120),
          rect(20, 20, 80, 20),
          rect(20, 20, 70, 10),
        ],
        text: [0, 0, 0, 0, 6],
        styles: [visibleStyles, visibleStyles, hiddenOverflowStyles, visibleStyles, []],
        paintOrders: [1, 1, 2, 3, 4],
      },
    }],
  };

  const raw = visibleNodesFromSnapshot(snapshot);
  assert.deepEqual(raw.map((node) => node.id), ["1", "2", "3", "4"]);
  assert.equal(raw.find((node) => node.id === "3")?.isInvisibleOverflowBoundary, true);
  assert.equal(raw.find((node) => node.id === "3")?.isVisible, false);
  assert.equal(raw.find((node) => node.id === "3")?.ownedOverflowScopeId, "overflow:3");
  assert.equal(raw.find((node) => node.id === "4")?.parentId, "3");
  assert.equal(raw.find((node) => node.id === "4")?.boxOverflowScopeId, "overflow:3");
});

test("intersectsExpandedViewport accepts meaningful viewport overlap", () => {
  const viewport = bounds({ x: 0, y: 0, width: 100, height: 100 });

  assert.equal(intersectsExpandedViewport(bounds({ x: 10, y: 10, width: 10, height: 10 }), viewport), true);
  assert.equal(intersectsExpandedViewport(bounds({ x: 200, y: 10, width: 10, height: 10 }), viewport), false);
  assert.equal(intersectsExpandedViewport(bounds({ x: 100, y: 10, width: 10, height: 10 }), viewport), false);
  assert.equal(intersectsExpandedViewport(bounds({ x: 100, y: 10, width: 10, height: 10 }), viewport, 1), true);
  assert.equal(intersectsExpandedViewport(bounds({ x: 0, y: 0, width: 100, height: 2000 }), viewport), true);
});

test("visibleNodesFromSnapshot filters retained elements and text by explicit viewport", () => {
  const snapshot = viewportSnapshot();
  const viewport = bounds({ x: 0, y: 0, width: 100, height: 100 });

  const unfiltered = visibleNodesFromSnapshot(snapshot);
  assert.deepEqual(unfiltered.map((node) => node.id), ["1", "2", "3", "4", "6"]);
  assert.equal(unfiltered.find((node) => node.id === "6")?.text, "Out");

  const filtered = visibleNodesFromSnapshot(snapshot, { viewportFilter: { viewport } });
  assert.deepEqual(filtered.map((node) => node.id), ["1", "2", "3", "4"]);
  assert.equal(filtered.find((node) => node.id === "4")?.text, "In");
  assert.equal(filtered.find((node) => node.id === "3")?.text, "");
});

test("visibleNodesFromSnapshot uses viewport margin for near-viewport nodes", () => {
  const snapshot = viewportSnapshot();
  const viewport = bounds({ x: 0, y: 0, width: 100, height: 100 });

  const filtered = visibleNodesFromSnapshot(snapshot, { viewportFilter: { viewport, margin: 1000 } });
  assert.deepEqual(filtered.map((node) => node.id), ["1", "2", "3", "4", "6"]);
  assert.equal(filtered.find((node) => node.id === "6")?.text, "Out");
});

test("visibleNodesFromSnapshot respects clipping ancestors without viewport filtering", () => {
  const snapshot = clippedViewportSnapshot();

  const filtered = visibleNodesFromSnapshot(snapshot);

  assert.deepEqual(filtered.map((node) => node.id), ["1", "2", "3", "6", "8", "10"]);
  assert.equal(filtered.find((node) => node.id === "4"), undefined);
  assert.equal(filtered.find((node) => node.id === "6")?.text, "Inside");
  assert.equal(filtered.find((node) => node.id === "8")?.text, "Off viewport");
  assert.equal(filtered.find((node) => node.id === "10")?.text, "Partial");
});

test("visibleNodesFromSnapshot combines viewport and clipping filters", () => {
  const snapshot = clippedViewportSnapshot();
  const viewport = bounds({ x: 0, y: 0, width: 200, height: 200 });

  const filtered = visibleNodesFromSnapshot(snapshot, { viewportFilter: { viewport } });

  assert.deepEqual(filtered.map((node) => node.id), ["1", "2", "3", "6", "10"]);
  assert.equal(filtered.find((node) => node.id === "4"), undefined);
  assert.equal(filtered.find((node) => node.id === "6")?.text, "Inside");
  assert.equal(filtered.find((node) => node.id === "8"), undefined);
  assert.equal(filtered.find((node) => node.id === "10")?.text, "Partial");
});

test("visibleNodesFromSnapshot applies overflow clipping per axis", () => {
  const xFiltered = visibleNodesFromSnapshot(axisClippingSnapshot({ overflowX: "hidden" }));
  assert.deepEqual(xFiltered.map((node) => node.id), ["1", "2", "3", "4", "8"]);
  assert.equal(xFiltered.find((node) => node.id === "4")?.text, "Y out");
  assert.equal(xFiltered.find((node) => node.id === "6"), undefined);

  const yFiltered = visibleNodesFromSnapshot(axisClippingSnapshot({ overflowY: "hidden" }));
  assert.deepEqual(yFiltered.map((node) => node.id), ["1", "2", "3", "6", "8"]);
  assert.equal(yFiltered.find((node) => node.id === "4"), undefined);
  assert.equal(yFiltered.find((node) => node.id === "6")?.text, "X out");

  const bothFiltered = visibleNodesFromSnapshot(axisClippingSnapshot({ overflow: "hidden" }));
  assert.deepEqual(bothFiltered.map((node) => node.id), ["1", "2", "3", "8"]);
  assert.equal(bothFiltered.find((node) => node.id === "4"), undefined);
  assert.equal(bothFiltered.find((node) => node.id === "6"), undefined);

  const clipFiltered = visibleNodesFromSnapshot(axisClippingSnapshot({ overflow: "clip" }));
  assert.deepEqual(clipFiltered.map((node) => node.id), ["1", "2", "3", "8"]);
  assert.equal(clipFiltered.find((node) => node.id === "4"), undefined);
  assert.equal(clipFiltered.find((node) => node.id === "6"), undefined);
  assert.equal(clipFiltered.find((node) => node.id === "3")?.maybeScrollRegion, false);
});

test("captureVisibleNodes falls back to css visual viewport when viewportFilter is enabled", async () => {
  const sentMethods: string[] = [];
  let detachCount = 0;
  const page = {
    context: () => ({
      newCDPSession: async () => ({
        send: async (method: string) => {
          sentMethods.push(method);
          if (method === "Page.getLayoutMetrics") {
            return {
              cssVisualViewport: {
                pageX: 0,
                pageY: 0,
                clientWidth: 100,
                clientHeight: 100,
              },
            };
          }
          if (method === "DOMSnapshot.captureSnapshot") return viewportSnapshot();
          throw new Error(`Unexpected CDP method: ${method}`);
        },
        detach: async () => {
          detachCount += 1;
        },
      }),
    }),
  } as unknown as Page;

  const raw = await captureVisibleNodes(page, { viewportFilter: true });

  assert.deepEqual(sentMethods, ["Page.getLayoutMetrics", "DOMSnapshot.captureSnapshot"]);
  assert.equal(detachCount, 1);
  assert.deepEqual(raw.map((node) => node.id), ["1", "2", "3", "4"]);
});

test("captureVisibleNodes prefers snapshot-coordinate visual viewport when available", async () => {
  const page = {
    context: () => ({
      newCDPSession: async () => ({
        send: async (method: string) => {
          if (method === "Page.getLayoutMetrics") {
            return {
              visualViewport: {
                pageX: 0,
                pageY: 0,
                clientWidth: 200,
                clientHeight: 200,
              },
              cssVisualViewport: {
                pageX: 0,
                pageY: 0,
                clientWidth: 100,
                clientHeight: 100,
              },
            };
          }
          if (method === "DOMSnapshot.captureSnapshot") return scaledViewportSnapshot();
          throw new Error(`Unexpected CDP method: ${method}`);
        },
        detach: async () => undefined,
      }),
    }),
  } as unknown as Page;

  const raw = await captureVisibleNodes(page, { viewportFilter: true });

  assert.deepEqual(raw.map((node) => node.id), ["1", "2", "3", "4", "8"]);
  assert.equal(raw.find((node) => node.id === "8")?.text, "Mid");
});

test("a retained element with no retained children becomes LEAF during collapse", () => {
  const raw = prepareNodes([
    element(1, null),
    element(2, 1, { width: 0, height: 0 }),
  ]);
  const collapsed = collapseDomTree(raw);

  assert.equal(collapsed.length, 1);
  assert.equal("type" in collapsed[0] ? collapsed[0].type : undefined, "LEAF");
});

test("collapseDomTree preserves invisible overflow boundaries", () => {
  const raw = prepareNodes([
    element(1, null),
    element(2, 1, { styles: styleMap({ overflow: "auto", visibility: "hidden" }) }),
    element(3, 2, { styles: styleMap({ visibility: "visible" }) }),
  ]);
  const collapsed = collapseDomTree(raw);
  const root = collapsed[0];
  const boundary = root?.children[0];

  assert.equal(boundary?.id, "2");
  assert.equal(boundary?.isInvisibleOverflowBoundary, true);
  assert.equal(boundary?.ownedOverflowScopeId, "overflow:2");
  assert.equal(boundary?.children[0]?.id, "3");
});

function element(
  nodeIndex: number,
  parentElementNodeIndex: number | null,
  overrides: ElementOverrides = {},
): DecodedLayoutElement {
  return {
    nodeType: 1,
    nodeIndex,
    parentElementNodeIndex,
    backendNodeId: overrides.backendNodeId ?? nodeIndex,
    tagName: overrides.tagName ?? "div",
    attributes: overrides.attributes ?? new Map(),
    styles: overrides.styles ?? styleMap(),
    bounds: overrides.bounds ?? bounds(overrides),
    paintOrder: overrides.paintOrder ?? 1,
  };
}

type ElementOverrides = Partial<Omit<DecodedLayoutElement, "bounds">> & Partial<Bounds> & { bounds?: Bounds };

function text(
  nodeIndex: number,
  parentElementNodeIndex: number | null,
  value: string,
  overrides: Partial<Bounds> = {},
): DecodedLayoutText {
  return {
    nodeType: 3,
    sourceNodeType: 3,
    nodeIndex,
    parentElementNodeIndex,
    text: value,
    bounds: bounds(overrides),
    paintOrder: 2,
  };
}

function bounds(overrides: Partial<Bounds> = {}): Bounds {
  const width = overrides.width ?? 200;
  const height = overrides.height ?? 100;
  return {
    x: overrides.x ?? 0,
    y: overrides.y ?? 0,
    width,
    height,
    area: overrides.area ?? Math.max(0, width * height),
  };
}

function rect(x: number, y: number, width: number, height: number): number[] {
  return [x, y, width, height];
}

function styleMap(overrides: Record<string, string> = {}): ReadonlyMap<string, string> {
  const styles = {
    display: "block",
    visibility: "visible",
    opacity: "1",
    "content-visibility": "visible",
    position: "static",
    "z-index": "auto",
    overflow: "visible",
    "overflow-x": "visible",
    "overflow-y": "visible",
    "pointer-events": "auto",
    cursor: "auto",
    transform: "none",
    filter: "none",
    perspective: "none",
    contain: "none",
    "will-change": "auto",
    ...overrides,
  };
  if (overrides.overflow && !("overflow-x" in overrides)) styles["overflow-x"] = overrides.overflow;
  if (overrides.overflow && !("overflow-y" in overrides)) styles["overflow-y"] = overrides.overflow;
  return new Map(Object.entries(styles));
}

function viewportSnapshot(): SnapshotResponse {
  const strings = [
    "",
    "#document",
    "HTML",
    "BODY",
    "DIV",
    "#text",
    "In",
    "Out",
    "block",
    "visible",
    "1",
    "static",
    "auto",
  ];
  const styles = [8, 9, 10, 9, 11, 12, 9, 9, 9, 12, 12];

  return {
    strings,
    documents: [{
      nodes: {
        parentIndex: [-1, 0, 1, 2, 3, 4, 3, 6],
        nodeType: [9, 1, 1, 1, 1, 3, 1, 3],
        nodeName: [1, 2, 3, 4, 4, 5, 4, 5],
        backendNodeId: [0, 1, 2, 3, 4, 0, 6, 0],
        attributes: [[], [], [], [], [], [], [], []],
      },
      layout: {
        nodeIndex: [1, 2, 3, 4, 5, 6, 7],
        bounds: [
          rect(0, 0, 500, 2000),
          rect(0, 0, 500, 2000),
          rect(0, 0, 500, 2000),
          rect(10, 10, 50, 20),
          rect(10, 10, 20, 10),
          rect(10, 1000, 50, 20),
          rect(10, 1000, 20, 10),
        ],
        text: [0, 0, 0, 0, 6, 0, 7],
        styles: [styles, styles, styles, styles, [], styles, []],
        paintOrders: [1, 1, 1, 2, 3, 2, 3],
      },
    }],
  };
}

function clippedViewportSnapshot(): SnapshotResponse {
  const strings = [
    "",
    "#document",
    "HTML",
    "BODY",
    "DIV",
    "#text",
    "Clipped",
    "Inside",
    "block",
    "visible",
    "1",
    "static",
    "auto",
    "hidden",
    "Partial",
    "Off viewport",
  ];
  const visibleStyles = [8, 9, 10, 9, 11, 12, 9, 9, 9, 12, 12];
  const clippingStyles = [8, 9, 10, 9, 11, 12, 13, 13, 13, 12, 12];

  return {
    strings,
    documents: [{
      nodes: {
        parentIndex: [-1, 0, 1, 2, 3, 4, 3, 6, 2, 8, 3, 10],
        nodeType: [9, 1, 1, 1, 1, 3, 1, 3, 1, 3, 1, 3],
        nodeName: [1, 2, 3, 4, 4, 5, 4, 5, 4, 5, 4, 5],
        backendNodeId: [0, 1, 2, 3, 4, 0, 6, 0, 8, 0, 10, 0],
        attributes: [[], [], [], [], [], [], [], [], [], [], [], []],
      },
      layout: {
        nodeIndex: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
        bounds: [
          rect(0, 0, 500, 500),
          rect(0, 0, 500, 500),
          rect(0, 60, 200, 100),
          rect(10, 10, 80, 20),
          rect(10, 10, 50, 10),
          rect(10, 80, 80, 20),
          rect(10, 80, 50, 10),
          rect(10, 1000, 80, 20),
          rect(10, 1000, 50, 10),
          rect(10, 150, 80, 30),
          rect(10, 150, 50, 10),
        ],
        text: [0, 0, 0, 0, 6, 0, 7, 0, 15, 0, 14],
        styles: [
          visibleStyles,
          visibleStyles,
          clippingStyles,
          visibleStyles,
          [],
          visibleStyles,
          [],
          visibleStyles,
          [],
          visibleStyles,
          [],
        ],
        paintOrders: [1, 1, 1, 2, 3, 2, 3, 2, 3, 2, 3],
      },
    }],
  };
}

function axisClippingSnapshot(overrides: { overflow?: string; overflowX?: string; overflowY?: string }): SnapshotResponse {
  const strings = [
    "",
    "#document",
    "HTML",
    "BODY",
    "DIV",
    "#text",
    "Y out",
    "X out",
    "Inside",
    "block",
    "visible",
    "1",
    "static",
    "auto",
    "hidden",
    "clip",
  ];
  const visibleStyles = [9, 10, 11, 10, 12, 13, 10, 10, 10, 13, 13];
  const clippingStyles = [
    9,
    10,
    11,
    10,
    12,
    13,
    styleStringIndex(strings, overrides.overflow ?? "visible"),
    styleStringIndex(strings, overrides.overflowX ?? "visible"),
    styleStringIndex(strings, overrides.overflowY ?? "visible"),
    13,
    13,
  ];

  return {
    strings,
    documents: [{
      nodes: {
        parentIndex: [-1, 0, 1, 2, 3, 4, 3, 6, 3, 8],
        nodeType: [9, 1, 1, 1, 1, 3, 1, 3, 1, 3],
        nodeName: [1, 2, 3, 4, 4, 5, 4, 5, 4, 5],
        backendNodeId: [0, 1, 2, 3, 4, 0, 6, 0, 8, 0],
        attributes: [[], [], [], [], [], [], [], [], [], []],
      },
      layout: {
        nodeIndex: [1, 2, 3, 4, 5, 6, 7, 8, 9],
        bounds: [
          rect(0, 0, 500, 500),
          rect(0, 0, 500, 500),
          rect(0, 0, 100, 100),
          rect(10, 150, 30, 20),
          rect(10, 150, 30, 10),
          rect(150, 10, 30, 20),
          rect(150, 10, 30, 10),
          rect(10, 10, 30, 20),
          rect(10, 10, 30, 10),
        ],
        text: [0, 0, 0, 0, 6, 0, 7, 0, 8],
        styles: [visibleStyles, visibleStyles, clippingStyles, visibleStyles, [], visibleStyles, [], visibleStyles, []],
        paintOrders: [1, 1, 1, 2, 3, 2, 3, 2, 3],
      },
    }],
  };
}

function styleStringIndex(strings: string[], value: string): number {
  const index = strings.indexOf(value);
  if (index === -1) throw new Error(`Missing style string: ${value}`);
  return index;
}

function scaledViewportSnapshot(): SnapshotResponse {
  const snapshot = viewportSnapshot();
  const document = snapshot.documents[0];
  if (!document) return snapshot;

  snapshot.strings.push("Mid");
  const midTextIndex = snapshot.strings.length - 1;
  document.nodes.parentIndex!.push(3, 8);
  document.nodes.nodeType!.push(1, 3);
  document.nodes.nodeName!.push(4, 5);
  document.nodes.backendNodeId!.push(8, 0);
  document.nodes.attributes!.push([], []);
  document.layout.nodeIndex!.push(8, 9);
  document.layout.bounds!.push(rect(10, 150, 50, 20), rect(10, 150, 20, 10));
  document.layout.text?.push(0, midTextIndex);
  document.layout.styles?.push([8, 9, 10, 9, 11, 12, 9, 9, 9, 12, 12], []);
  document.layout.paintOrders?.push(2, 3);
  return snapshot;
}
