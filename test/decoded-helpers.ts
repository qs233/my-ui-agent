import { visibleNodesFromSnapshot } from "../src/prepare.js";
import { COMPUTED_STYLES } from "../src/snapshot.js";
import type { Bounds, DomNodeRecord, SnapshotOptions, SnapshotResponse } from "../src/types.js";

interface DecodedLayoutNodeBase {
  nodeIndex: number;
  parentElementNodeIndex: number | null;
  bounds: Bounds;
  paintOrder: number;
}

export interface DecodedLayoutElement extends DecodedLayoutNodeBase {
  nodeType: 1;
  backendNodeId: number;
  tagName: string;
  attributes: ReadonlyMap<string, string>;
  styles: ReadonlyMap<string, string>;
}

export interface DecodedLayoutText extends DecodedLayoutNodeBase {
  nodeType: 3;
  sourceNodeType: 1 | 3;
  text: string;
}

export type DecodedLayoutNode = DecodedLayoutElement | DecodedLayoutText;

export function prepareNodes(nodes: DecodedLayoutNode[], options: SnapshotOptions = {}): DomNodeRecord[] {
  return visibleNodesFromSnapshot(snapshotFromDecodedNodes(nodes), options);
}

function snapshotFromDecodedNodes(nodes: DecodedLayoutNode[]): SnapshotResponse {
  const strings = [""];
  const parentIndex = [-1];
  const nodeType = [9];
  const nodeName = [stringIndex(strings, "#document")];
  const backendNodeId = [0];
  const attributes: number[][] = [[]];
  const layoutNodeIndex: number[] = [];
  const bounds: number[][] = [];
  const text: number[] = [];
  const styles: number[][] = [];
  const paintOrders: number[] = [];

  const maxNodeIndex = Math.max(0, ...nodes.map((node) => node.nodeIndex));
  for (let index = 1; index <= maxNodeIndex; index += 1) {
    parentIndex[index] = -1;
    nodeType[index] = 0;
    nodeName[index] = 0;
    backendNodeId[index] = 0;
    attributes[index] = [];
  }

  for (const node of nodes) {
    parentIndex[node.nodeIndex] = node.parentElementNodeIndex ?? 0;
    nodeType[node.nodeIndex] = node.nodeType;
    nodeName[node.nodeIndex] = stringIndex(strings, node.nodeType === 1 ? node.tagName.toUpperCase() : "#text");
    backendNodeId[node.nodeIndex] = node.nodeType === 1 ? node.backendNodeId : 0;
    attributes[node.nodeIndex] = node.nodeType === 1 ? encodeAttributes(strings, node.attributes) : [];

    layoutNodeIndex.push(node.nodeIndex);
    bounds.push([node.bounds.x, node.bounds.y, node.bounds.width, node.bounds.height]);
    text.push(node.nodeType === 3 ? stringIndex(strings, node.text) : 0);
    styles.push(node.nodeType === 1 ? encodeStyles(strings, node.styles) : []);
    paintOrders.push(node.paintOrder);
  }

  return {
    strings,
    documents: [{
      nodes: {
        parentIndex,
        nodeType,
        nodeName,
        backendNodeId,
        attributes,
      },
      layout: {
        nodeIndex: layoutNodeIndex,
        bounds,
        text,
        styles,
        paintOrders,
      },
    }],
  };
}

function encodeAttributes(strings: string[], attributes: ReadonlyMap<string, string>): number[] {
  const encoded: number[] = [];
  for (const [name, value] of attributes) {
    encoded.push(stringIndex(strings, name), stringIndex(strings, value));
  }
  return encoded;
}

function encodeStyles(strings: string[], styles: ReadonlyMap<string, string>): number[] {
  return COMPUTED_STYLES.map((property) => stringIndex(strings, styles.get(property) ?? ""));
}

function stringIndex(strings: string[], value: string): number {
  let index = strings.indexOf(value);
  if (index === -1) {
    index = strings.length;
    strings.push(value);
  }
  return index;
}
