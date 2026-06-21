import assert from "node:assert/strict";
import test from "node:test";
import { compressDomTree } from "../src/compress.js";
import { decodeSnapshot, prepareNodes } from "../src/prepare.js";
import type {
  Bounds,
  DecodedLayoutElement,
  DecodedLayoutNode,
  DecodedLayoutText,
  SnapshotResponse,
} from "../src/types.js";

test("decodeSnapshot keeps element and text layout nodes while skipping pseudo elements", () => {
  const strings = ["", "#document", "HTML", "BODY", "#text", "::before", "Visible", "Generated", "block", "visible", "1", "static", "auto"];
  const styles = [8, 9, 10, 9, 11, 12, 9, 9, 9, 12, 12];
  const snapshot: SnapshotResponse = {
    strings,
    documents: [{
      nodes: {
        parentIndex: [-1, 0, 1, 2, 2, 4],
        nodeType: [9, 1, 1, 3, 1, 3],
        nodeName: [1, 2, 3, 4, 5, 4],
        backendNodeId: [0, 1, 2, 3, 4, 5],
        attributes: [[], [], [], [], [], []],
        pseudoType: { index: [4], value: [0] },
      },
      layout: {
        nodeIndex: [1, 2, 3, 4, 5],
        bounds: [rect(0, 0, 300, 200), rect(0, 0, 300, 200), rect(10, 10, 60, 20), rect(0, 0, 80, 20), rect(0, 0, 80, 20)],
        text: [0, 0, 6, 0, 7],
        styles: [styles, styles, [], styles, []],
        paintOrders: [1, 1, 2, 2, 2],
      },
    }],
  };

  const decoded = decodeSnapshot(snapshot);
  assert.deepEqual(decoded.map((node) => node.nodeType), [1, 1, 3, 3]);
  assert.equal(decoded.some((node) => node.nodeIndex === 4), false);
  const pseudoText = decoded.find((node) => node.nodeIndex === 5);
  assert.equal(pseudoText?.parentElementNodeIndex, 2);
});

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
  assert.equal(raw.find((node) => node.id === "3")?.domParentId, "1");
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

test("a retained element with no retained children becomes LEAF during compression", () => {
  const raw = prepareNodes([
    element(1, null),
    element(2, 1, { width: 0, height: 0 }),
  ]);
  const compressed = compressDomTree(raw);

  assert.equal(compressed.length, 1);
  assert.equal(compressed[0].type, "LEAF");
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
  return new Map(Object.entries({
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
    ...overrides,
  }));
}
