export type NodeKind = "ENTITY" | "ZONE";

export interface RawNode {
  id: string;
  backendNodeId: number;
  tagName: string;
  className: string;
  name: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  area: number;
  paintOrder: number;
  domParentId: string | null;
  position: string;
  zIndex?: number;
  isVisible: boolean;
  isInteractive: boolean;
  isScrollable: boolean;
}

export interface TreeNode extends RawNode {
  type: NodeKind;
  mergedDomIds: string[];
  children: TreeNode[];
}

export interface CaptureOverviewOptions {
  timeoutMs?: number;
  waitUntil?: "domcontentloaded" | "load" | "networkidle";
  viewport?: {
    width: number;
    height: number;
  };
  textMaxLength?: number;
  keepBrowserOpen?: boolean;
}

export interface SerializeOverviewOptions {
  textMaxLength?: number;
}
