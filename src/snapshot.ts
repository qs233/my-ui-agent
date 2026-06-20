import { chromium } from "playwright";
import { appendText, truncateText } from "./text.js";
import type { CaptureOverviewOptions, RawNode } from "./types.js";

const COMPUTED_STYLES = [
  "display",
  "visibility",
  "opacity",
  "position",
  "z-index",
  "overflow",
  "overflow-x",
  "overflow-y",
  "pointer-events",
  "cursor",
] as const;

const IGNORED_TAGS = new Set(["script", "style", "meta", "link", "noscript", "template", "head", "title"]);
const INTERACTIVE_TAGS = new Set(["button", "input", "select", "textarea", "summary", "option"]);

type SnapshotResponse = {
  documents: SnapshotDocument[];
  strings: string[];
};

type SnapshotDocument = {
  nodes: {
    parentIndex?: number[];
    nodeType?: number[];
    nodeName?: number[];
    nodeValue?: number[];
    backendNodeId?: number[];
    attributes?: number[][];
  };
  layout: {
    nodeIndex?: number[];
    bounds?: number[][];
    text?: number[];
    styles?: number[][];
    paintOrders?: number[];
  };
};

interface ElementCandidate {
  nodeIndex: number;
  backendNodeId: number;
  tagName: string;
  attributes: Map<string, string>;
  parentNodeIndex: number | null;
  layoutIndex: number;
  bounds: number[];
  styles: Map<string, string>;
  paintOrder: number;
}

export async function captureRawNodes(url: string, options: CaptureOverviewOptions = {}): Promise<RawNode[]> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: options.viewport ?? { width: 1280, height: 720 },
  });

  try {
    const timeout = options.timeoutMs ?? 30_000;
    await page.goto(url, {
      waitUntil: options.waitUntil ?? "load",
      timeout,
    });

    const session = await page.context().newCDPSession(page);
    const snapshot = (await session.send("DOMSnapshot.captureSnapshot", {
      computedStyles: [...COMPUTED_STYLES],
      includePaintOrder: true,
    })) as SnapshotResponse;

    return rawNodesFromSnapshot(snapshot, options);
  } finally {
    if (!options.keepBrowserOpen) {
      await browser.close();
    }
  }
}

export function rawNodesFromSnapshot(snapshot: SnapshotResponse, options: CaptureOverviewOptions = {}): RawNode[] {
  const document = snapshot.documents[0];
  if (!document) return [];

  const textMaxLength = options.textMaxLength ?? 80;
  const strings = snapshot.strings;
  const layoutNodeIndexes = document.layout.nodeIndex ?? [];
  const candidates = new Map<number, ElementCandidate>();
  const rawByNodeIndex = new Map<number, RawNode>();
  const retainedNodeIndexes = new Set<number>();

  for (let layoutIndex = 0; layoutIndex < layoutNodeIndexes.length; layoutIndex += 1) {
    const nodeIndex = layoutNodeIndexes[layoutIndex];
    const nodeType = document.nodes.nodeType?.[nodeIndex];
    if (nodeType !== 1) continue;

    const tagName = readString(strings, document.nodes.nodeName?.[nodeIndex]).toLowerCase();
    if (!tagName || IGNORED_TAGS.has(tagName)) continue;

    const bounds = document.layout.bounds?.[layoutIndex];
    if (!bounds || bounds.length < 4) continue;

    const width = Number(bounds[2]);
    const height = Number(bounds[3]);
    if (!Number.isFinite(width) || !Number.isFinite(height)) continue;

    const attributes = readAttributes(strings, document.nodes.attributes?.[nodeIndex] ?? []);
    const styles = readStyles(strings, document.layout.styles?.[layoutIndex] ?? []);
    const backendNodeId = document.nodes.backendNodeId?.[nodeIndex];
    if (backendNodeId === undefined) continue;

    const candidate: ElementCandidate = {
      nodeIndex,
      backendNodeId,
      tagName,
      attributes,
      parentNodeIndex: readParentIndex(document, nodeIndex),
      layoutIndex,
      bounds,
      styles,
      paintOrder: document.layout.paintOrders?.[layoutIndex] ?? layoutIndex,
    };

    candidates.set(nodeIndex, candidate);
  }

  for (const candidate of candidates.values()) {
    const raw = candidateToRawNode(candidate, candidates, textMaxLength);
    rawByNodeIndex.set(candidate.nodeIndex, raw);
    retainedNodeIndexes.add(candidate.nodeIndex);
  }

  collectLayoutText(document, strings, rawByNodeIndex, retainedNodeIndexes, textMaxLength);
  collectFallbackNodeText(document, strings, rawByNodeIndex, retainedNodeIndexes, textMaxLength);

  return [...rawByNodeIndex.values()];
}

function candidateToRawNode(
  candidate: ElementCandidate,
  candidates: Map<number, ElementCandidate>,
  textMaxLength: number,
): RawNode {
  const [x, y, width, height] = candidate.bounds.map(Number);
  const className = truncateText(candidate.attributes.get("class") ?? "", textMaxLength);
  const name = truncateText(candidate.attributes.get("name") ?? "", textMaxLength);

  return {
    id: String(candidate.backendNodeId),
    backendNodeId: candidate.backendNodeId,
    tagName: candidate.tagName,
    className,
    name,
    text: "",
    x,
    y,
    width,
    height,
    area: Math.max(0, width * height),
    paintOrder: candidate.paintOrder,
    domParentId: findRetainedParentId(candidate, candidates),
    position: candidate.styles.get("position") ?? "static",
    zIndex: parseZIndex(candidate.styles.get("z-index")),
    isVisible: isVisible(candidate),
    isInteractive: isNativeInteractive(candidate),
    isScrollable: isScrollable(candidate.styles),
  };
}

function readParentIndex(document: SnapshotDocument, nodeIndex: number): number | null {
  const parentIndex = document.nodes.parentIndex?.[nodeIndex];
  return parentIndex === undefined || parentIndex < 0 ? null : parentIndex;
}

function findRetainedParentId(candidate: ElementCandidate, candidates: Map<number, ElementCandidate>): string | null {
  let parentNodeIndex = candidate.parentNodeIndex;

  while (parentNodeIndex !== null) {
    const parent = candidates.get(parentNodeIndex);
    if (parent) return String(parent.backendNodeId);
    parentNodeIndex = parentNodeIndex >= 0 ? candidates.get(parentNodeIndex)?.parentNodeIndex ?? null : null;
  }

  return null;
}

function collectLayoutText(
  document: SnapshotDocument,
  strings: string[],
  rawByNodeIndex: Map<number, RawNode>,
  retainedNodeIndexes: Set<number>,
  textMaxLength: number,
): void {
  const layoutNodeIndexes = document.layout.nodeIndex ?? [];
  const layoutTexts = document.layout.text ?? [];

  for (let layoutIndex = 0; layoutIndex < layoutNodeIndexes.length; layoutIndex += 1) {
    const text = readString(strings, layoutTexts[layoutIndex]);
    if (!text) continue;

    const ownerNodeIndex = findNearestRetainedAncestor(document, layoutNodeIndexes[layoutIndex], retainedNodeIndexes);
    if (ownerNodeIndex === null) continue;

    const raw = rawByNodeIndex.get(ownerNodeIndex);
    if (raw) raw.text = appendText(raw.text, text, textMaxLength);
  }
}

function collectFallbackNodeText(
  document: SnapshotDocument,
  strings: string[],
  rawByNodeIndex: Map<number, RawNode>,
  retainedNodeIndexes: Set<number>,
  textMaxLength: number,
): void {
  const nodeValues = document.nodes.nodeValue ?? [];
  const nodeTypes = document.nodes.nodeType ?? [];

  for (let nodeIndex = 0; nodeIndex < nodeValues.length; nodeIndex += 1) {
    if (nodeTypes[nodeIndex] !== 3) continue;
    const text = readString(strings, nodeValues[nodeIndex]);
    if (!text) continue;

    const ownerNodeIndex = findNearestRetainedAncestor(document, nodeIndex, retainedNodeIndexes);
    if (ownerNodeIndex === null) continue;

    const raw = rawByNodeIndex.get(ownerNodeIndex);
    if (raw && !raw.text) raw.text = appendText(raw.text, text, textMaxLength);
  }
}

function findNearestRetainedAncestor(
  document: SnapshotDocument,
  nodeIndex: number,
  retainedNodeIndexes: Set<number>,
): number | null {
  let current: number | null = nodeIndex;

  while (current !== null) {
    if (retainedNodeIndexes.has(current)) return current;
    current = readParentIndex(document, current);
  }

  return null;
}

function readAttributes(strings: string[], encoded: number[]): Map<string, string> {
  const attributes = new Map<string, string>();
  for (let index = 0; index < encoded.length; index += 2) {
    const name = readString(strings, encoded[index]).toLowerCase();
    const value = readString(strings, encoded[index + 1]);
    if (name) attributes.set(name, value);
  }
  return attributes;
}

function readStyles(strings: string[], encoded: number[]): Map<string, string> {
  const styles = new Map<string, string>();
  for (let index = 0; index < COMPUTED_STYLES.length; index += 1) {
    styles.set(COMPUTED_STYLES[index], readString(strings, encoded[index]));
  }
  return styles;
}

function readString(strings: string[], index: number | undefined): string {
  if (index === undefined || index < 0) return "";
  return strings[index] ?? "";
}

function isVisible(candidate: ElementCandidate): boolean {
  const display = candidate.styles.get("display");
  const visibility = candidate.styles.get("visibility");
  const opacity = Number(candidate.styles.get("opacity") ?? "1");
  const [, , width, height] = candidate.bounds.map(Number);

  return (
    width > 0 &&
    height > 0 &&
    display !== "none" &&
    visibility !== "hidden" &&
    visibility !== "collapse" &&
    opacity !== 0
  );
}

function isNativeInteractive(candidate: ElementCandidate): boolean {
  if (INTERACTIVE_TAGS.has(candidate.tagName)) return true;
  return candidate.tagName === "a" && candidate.attributes.has("href");
}

function isScrollable(styles: Map<string, string>): boolean {
  const values = [styles.get("overflow"), styles.get("overflow-x"), styles.get("overflow-y")];
  return values.some((value) => value === "auto" || value === "scroll");
}

function parseZIndex(value: string | undefined): number | undefined {
  if (!value || value === "auto") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
