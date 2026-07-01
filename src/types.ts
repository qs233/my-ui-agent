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

export type DomNodeId = string;

export interface DomNodeRecord extends Bounds {
  id: DomNodeId;
  parentId: DomNodeId | null;
  childIds: DomNodeId[];
  bounds: Bounds;
  tagName: string;
  className: string;
  name: string;
  text: string;
  paintOrder: number;
  position: string;
  zIndex?: number;
  isInteractive: boolean;
  maybeScrollRegion: boolean;
  overflowX: string;
  overflowY: string;
  boxOverflowScopeId: string;
  ownedOverflowScopeId?: string;
  isVisible: boolean;
  isInvisibleOverflowBoundary: boolean;
}

export interface RawNode extends DomNodeRecord {}

export interface BaseCollapsedNode extends Bounds {
  id: string;
  representativeDomNodeId: DomNodeId;
  collapsedDomNodeIds: DomNodeId[];
  visualBounds: Bounds;
  ownBounds: Bounds;
  ctParentId: DomNodeId | null;
  tagName: string;
  className: string;
  name: string;
  text: string;
  paintOrder: number;
  position: string;
  zIndex?: number;
  maybeScrollRegion: boolean;
  overflowX: string;
  overflowY: string;
  boxOverflowScopeId: string;
  ownedOverflowScopeId?: string;
  isVisible: boolean;
  isInvisibleOverflowBoundary: boolean;
}

export interface LeafNode extends BaseCollapsedNode {
  type: "LEAF";
}

export type CollapsedNode = BaseCollapsedNode | LeafNode;

export type CollapsedTreeNode = CollapsedNode & { children: CollapsedTreeNode[] };

export type VctNode = CollapsedNode & {
  children: VctNode[];
  vctId: number;
  vctParentId: number | null;
  isCollapsed: boolean;
  isReparented: boolean;
  floating: boolean;
  alignToId?: number;
};

export interface VctSnapshot {
  domNodes: Map<DomNodeId, DomNodeRecord>;
  collapsedNodes: Map<string, CollapsedNode>;
  vctRoots: VctNode[];
}

export interface AlignmentResolverContext {
  candidates: readonly VctNode[];
}

export type AlignmentResolver = (
  node: VctNode,
  context: AlignmentResolverContext,
) => VctNode | undefined;

export interface BuildVisualContainmentTreeOptions {
  alignmentResolver?: AlignmentResolver;
}

export interface SnapshotOptions {
  textMaxLength?: number;
  viewportFilter?: boolean | ViewportFilterOptions;
}

export interface ViewportFilterOptions {
  margin?: number;
  viewport?: Bounds;
}

export interface CaptureOverviewOptions extends SnapshotOptions {
  timeoutMs?: number;
  waitUntil?: "domcontentloaded" | "load" | "networkidle";
  pageViewport?: {
    width: number;
    height: number;
  };
  keepBrowserOpen?: boolean;
}

export interface SerializeOverviewOptions {
  textMaxLength?: number;
}
