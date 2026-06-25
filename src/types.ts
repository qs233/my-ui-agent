export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
  area: number;
}

export interface SnapshotRareStringData {
  index: number[];
  value: number[];
}

export interface SnapshotNodeTable {
  parentIndex?: number[];
  nodeType?: number[];
  nodeName?: number[];
  nodeValue?: number[];
  backendNodeId?: number[];
  attributes?: number[][];
  pseudoType?: SnapshotRareStringData;
}

export interface SnapshotLayoutTable {
  nodeIndex?: number[];
  bounds?: number[][];
  text?: number[];
  styles?: number[][];
  paintOrders?: number[];
}

export interface SnapshotDocument {
  nodes: SnapshotNodeTable;
  layout: SnapshotLayoutTable;
}

export interface SnapshotResponse {
  documents: SnapshotDocument[];
  strings: string[];
}

export interface DecodedLayoutNodeBase {
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

export interface RetainedLayoutElement extends DecodedLayoutElement {
  readonly retained: true;
}

export interface RawNode extends Bounds {
  id: string;
  backendNodeId: number;
  tagName: string;
  className: string;
  name: string;
  text: string;
  paintOrder: number;
  domParentId: string | null;
  position: string;
  zIndex?: number;
  isInteractive: boolean;
  isScrollable: boolean;
}

export interface BaseCollapsedNode extends RawNode {
  wrapperDomIds: string[];
}

export interface LeafNode extends BaseCollapsedNode {
  type: "LEAF";
}

export type CollapsedNode = BaseCollapsedNode | LeafNode;

export type TreeNode = CollapsedNode & { children: TreeNode[] };

export interface SnapshotOptions {
  textMaxLength?: number;
}

export interface CaptureOverviewOptions extends SnapshotOptions {
  timeoutMs?: number;
  waitUntil?: "domcontentloaded" | "load" | "networkidle";
  viewport?: {
    width: number;
    height: number;
  };
  keepBrowserOpen?: boolean;
}

export interface SerializeOverviewOptions {
  textMaxLength?: number;
}
