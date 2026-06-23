import { COMPUTED_STYLES } from "./snapshot.js";
import { appendText, normalizeText, truncateText } from "./text.js";
import type {
  Bounds,
  DecodedLayoutElement,
  DecodedLayoutNode,
  DecodedLayoutText,
  RawNode,
  RetainedLayoutElement,
  SnapshotDocument,
  SnapshotOptions,
  SnapshotResponse,
} from "./types.js";

const INTERACTIVE_TAGS = new Set(["button", "input", "select", "textarea", "summary", "option"]);

export function decodeSnapshot(snapshot: SnapshotResponse): DecodedLayoutNode[] {
  const document = snapshot.documents[0];
  if (!document) return [];

  const strings = snapshot.strings;
  const layoutNodeIndexes = document.layout.nodeIndex ?? [];
  const pseudoNodeIndexes = new Set(document.nodes.pseudoType?.index ?? []);
  const elementNodeIndexes = collectDecodableElementIndexes(document, strings, pseudoNodeIndexes);
  const decoded: DecodedLayoutNode[] = [];

  for (let layoutIndex = 0; layoutIndex < layoutNodeIndexes.length; layoutIndex += 1) {
    const nodeIndex = layoutNodeIndexes[layoutIndex];
    const nodeType = document.nodes.nodeType?.[nodeIndex];
    if (nodeType !== 1 && nodeType !== 3) continue;
    const isPseudoElement = nodeType === 1 && pseudoNodeIndexes.has(nodeIndex);

    const bounds = decodeBounds(document.layout.bounds?.[layoutIndex]);
    if (!bounds) continue;

    const base = {
      nodeIndex,
      parentElementNodeIndex: findNearestElementNodeIndex(
        readParentIndex(document, nodeIndex),
        document,
        elementNodeIndexes,
      ),
      bounds,
      paintOrder: document.layout.paintOrders?.[layoutIndex] ?? layoutIndex,
    };

    const layoutText = readString(strings, document.layout.text?.[layoutIndex]);
    if (nodeType === 3 || (isPseudoElement && normalizeText(layoutText))) {
      const textNode: DecodedLayoutText = {
        ...base,
        nodeType: 3,
        sourceNodeType: nodeType,
        text: layoutText,
      };
      decoded.push(textNode);
      continue;
    }

    if (isPseudoElement) continue;
    if (!elementNodeIndexes.has(nodeIndex)) continue;
    const backendNodeId = document.nodes.backendNodeId?.[nodeIndex];
    if (backendNodeId === undefined) continue;

    const element: DecodedLayoutElement = {
      ...base,
      nodeType: 1,
      backendNodeId,
      tagName: readString(strings, document.nodes.nodeName?.[nodeIndex]).toLowerCase(),
      attributes: readAttributes(strings, document.nodes.attributes?.[nodeIndex] ?? []),
      styles: readStyles(strings, document.layout.styles?.[layoutIndex] ?? []),
    };
    decoded.push(element);
  }

  return decoded;
}

export function prepareNodes(decodedNodes: DecodedLayoutNode[], options: SnapshotOptions = {}): RawNode[] {
  const textMaxLength = options.textMaxLength ?? 80;
  const decodedElements = new Map<number, DecodedLayoutElement>();
  for (const node of decodedNodes) {
    if (node.nodeType === 1) decodedElements.set(node.nodeIndex, node);
  }

  const retainedElements = new Map<number, RetainedLayoutElement>();
  const renderBlockedMemo = new Map<number, boolean>();
  for (const element of decodedElements.values()) {
    if (!isRetainedElement(element, decodedElements, renderBlockedMemo)) continue;
    retainedElements.set(element.nodeIndex, { ...element, retained: true });
  }

  const textByOwner = new Map<number, string>();
  for (const node of decodedNodes) {
    if (node.nodeType !== 3 || !isUsableText(node)) continue;
    if (isTextRenderBlocked(node, decodedElements, renderBlockedMemo)) continue;

    const ownerNodeIndex = findNearestRetainedElement(
      node.parentElementNodeIndex,
      decodedElements,
      retainedElements,
    );
    if (ownerNodeIndex === null) continue;
    textByOwner.set(ownerNodeIndex, appendText(textByOwner.get(ownerNodeIndex) ?? "", node.text, textMaxLength));
  }

  const rawNodes: RawNode[] = [];
  for (const element of retainedElements.values()) {
    const parentNodeIndex = findNearestRetainedElement(
      element.parentElementNodeIndex,
      decodedElements,
      retainedElements,
    );
    const parent = parentNodeIndex === null ? undefined : retainedElements.get(parentNodeIndex);

    rawNodes.push({
      id: String(element.backendNodeId),
      backendNodeId: element.backendNodeId,
      tagName: element.tagName,
      className: truncateText(element.attributes.get("class") ?? "", textMaxLength),
      name: truncateText(element.attributes.get("name") ?? "", textMaxLength),
      text: textByOwner.get(element.nodeIndex) ?? "",
      ...element.bounds,
      paintOrder: element.paintOrder,
      domParentId: parent ? String(parent.backendNodeId) : null,
      position: element.styles.get("position") ?? "static",
      zIndex: parseZIndex(element.styles.get("z-index")),
      isInteractive: isNativeInteractive(element),
      isScrollable: isScrollable(element.styles),
    });
  }

  return rawNodes;
}

export function rawNodesFromSnapshot(snapshot: SnapshotResponse, options: SnapshotOptions = {}): RawNode[] {
  const document = snapshot.documents[0];
  if (!document) return [];

  const textMaxLength = options.textMaxLength ?? 80;
  const { elements, texts } = collectSnapshotLayoutCandidates(document, snapshot.strings);
  const retainedElements = new Map<number, SnapshotLayoutElementCandidate>();
  const renderBlockedMemo = new Map<number, boolean>();

  for (const element of elements.values()) {
    if (!isRetainedSnapshotElement(element, document, elements, renderBlockedMemo)) continue;
    retainedElements.set(element.nodeIndex, element);
  }

  const textByOwner = new Map<number, string>();
  for (const text of texts) {
    if (!isUsableSnapshotText(text)) continue;
    if (isSnapshotTextRenderBlocked(text, document, elements, renderBlockedMemo)) continue;

    const ownerNodeIndex = findNearestRetainedSnapshotElement(
      readParentIndex(document, text.nodeIndex),
      document,
      retainedElements,
    );
    if (ownerNodeIndex === null) continue;
    textByOwner.set(ownerNodeIndex, appendText(textByOwner.get(ownerNodeIndex) ?? "", text.text, textMaxLength));
  }

  const rawNodes: RawNode[] = [];
  for (const element of retainedElements.values()) {
    const parentNodeIndex = findNearestRetainedSnapshotElement(
      readParentIndex(document, element.nodeIndex),
      document,
      retainedElements,
    );
    const parent = parentNodeIndex === null ? undefined : retainedElements.get(parentNodeIndex);

    rawNodes.push({
      id: String(element.backendNodeId),
      backendNodeId: element.backendNodeId,
      tagName: element.tagName,
      className: truncateText(element.attributes.get("class") ?? "", textMaxLength),
      name: truncateText(element.attributes.get("name") ?? "", textMaxLength),
      text: textByOwner.get(element.nodeIndex) ?? "",
      ...element.bounds,
      paintOrder: element.paintOrder,
      domParentId: parent ? String(parent.backendNodeId) : null,
      position: element.styles.get("position") ?? "static",
      zIndex: parseZIndex(element.styles.get("z-index")),
      isInteractive: isNativeInteractive(element),
      isScrollable: isScrollable(element.styles),
    });
  }

  return rawNodes;
}

interface SnapshotLayoutElementCandidate {
  nodeIndex: number;
  backendNodeId: number;
  tagName: string;
  attributes: ReadonlyMap<string, string>;
  styles: ReadonlyMap<string, string>;
  bounds: Bounds;
  paintOrder: number;
}

interface SnapshotLayoutTextCandidate {
  nodeIndex: number;
  bounds: Bounds;
  paintOrder: number;
  text: string;
}

function collectSnapshotLayoutCandidates(
  document: SnapshotDocument,
  strings: string[],
): {
  elements: Map<number, SnapshotLayoutElementCandidate>;
  texts: SnapshotLayoutTextCandidate[];
} {
  const elements = new Map<number, SnapshotLayoutElementCandidate>();
  const texts: SnapshotLayoutTextCandidate[] = [];
  const layoutNodeIndexes = document.layout.nodeIndex ?? [];
  const pseudoNodeIndexes = new Set(document.nodes.pseudoType?.index ?? []);

  for (let layoutIndex = 0; layoutIndex < layoutNodeIndexes.length; layoutIndex += 1) {
    const nodeIndex = layoutNodeIndexes[layoutIndex];
    const nodeType = document.nodes.nodeType?.[nodeIndex];
    if (nodeType !== 1 && nodeType !== 3) continue;

    const bounds = decodeBounds(document.layout.bounds?.[layoutIndex]);
    if (!bounds) continue;

    const paintOrder = document.layout.paintOrders?.[layoutIndex] ?? layoutIndex;
    const layoutText = readString(strings, document.layout.text?.[layoutIndex]);
    const isPseudoElement = nodeType === 1 && pseudoNodeIndexes.has(nodeIndex);

    if (nodeType === 3 || (isPseudoElement && normalizeText(layoutText))) {
      texts.push({
        nodeIndex,
        bounds,
        paintOrder,
        text: layoutText,
      });
      continue;
    }

    if (isPseudoElement) continue;
    const backendNodeId = document.nodes.backendNodeId?.[nodeIndex];
    if (backendNodeId === undefined) continue;

    const tagName = readString(strings, document.nodes.nodeName?.[nodeIndex]).toLowerCase();
    if (!tagName) continue;

    elements.set(nodeIndex, {
      nodeIndex,
      backendNodeId,
      tagName,
      attributes: readAttributes(strings, document.nodes.attributes?.[nodeIndex] ?? []),
      styles: readStyles(strings, document.layout.styles?.[layoutIndex] ?? []),
      bounds,
      paintOrder,
    });
  }

  return { elements, texts };
}

function collectDecodableElementIndexes(
  document: SnapshotDocument,
  strings: string[],
  pseudoNodeIndexes: Set<number>,
): Set<number> {
  const indexes = new Set<number>();
  const layoutNodeIndexes = document.layout.nodeIndex ?? [];
  for (let layoutIndex = 0; layoutIndex < layoutNodeIndexes.length; layoutIndex += 1) {
    const nodeIndex = layoutNodeIndexes[layoutIndex];
    if (document.nodes.nodeType?.[nodeIndex] !== 1 || pseudoNodeIndexes.has(nodeIndex)) continue;
    if (!decodeBounds(document.layout.bounds?.[layoutIndex])) continue;
    const tagName = readString(strings, document.nodes.nodeName?.[nodeIndex]).toLowerCase();
    if (tagName && document.nodes.backendNodeId?.[nodeIndex] !== undefined) indexes.add(nodeIndex);
  }
  return indexes;
}

function decodeBounds(encoded: number[] | undefined): Bounds | null {
  if (!encoded || encoded.length < 4) return null;
  const [x, y, width, height] = encoded.map(Number);
  if (![x, y, width, height].every(Number.isFinite)) return null;
  return { x, y, width, height, area: Math.max(0, width * height) };
}

function isRetainedElement(
  element: DecodedLayoutElement,
  elements: Map<number, DecodedLayoutElement>,
  renderBlockedMemo: Map<number, boolean>,
): boolean {
  if (element.bounds.width <= 0 || element.bounds.height <= 0) return false;
  if (element.styles.get("display") === "none") return false;
  const visibility = element.styles.get("visibility");
  if (visibility === "hidden" || visibility === "collapse") return false;
  return !isElementRenderBlocked(element, elements, renderBlockedMemo);
}

function isElementRenderBlocked(
  element: DecodedLayoutElement,
  elements: Map<number, DecodedLayoutElement>,
  memo: Map<number, boolean>,
): boolean {
  const cached = memo.get(element.nodeIndex);
  if (cached !== undefined) return cached;

  const opacity = Number(element.styles.get("opacity") ?? "1");
  const blocksSelf = opacity === 0 || element.styles.get("content-visibility") === "hidden";
  const parent = element.parentElementNodeIndex === null ? undefined : elements.get(element.parentElementNodeIndex);
  const blocked = blocksSelf || (parent ? isElementRenderBlocked(parent, elements, memo) : false);
  memo.set(element.nodeIndex, blocked);
  return blocked;
}

function isUsableText(node: DecodedLayoutText): boolean {
  return normalizeText(node.text).length > 0 && node.bounds.width > 0 && node.bounds.height > 0;
}

function isTextRenderBlocked(
  text: DecodedLayoutText,
  elements: Map<number, DecodedLayoutElement>,
  memo: Map<number, boolean>,
): boolean {
  const nearestElement = text.parentElementNodeIndex === null ? undefined : elements.get(text.parentElementNodeIndex);
  if (!nearestElement) return true;
  const visibility = nearestElement.styles.get("visibility");
  return visibility === "hidden" || visibility === "collapse" || isElementRenderBlocked(nearestElement, elements, memo);
}

function isRetainedSnapshotElement(
  element: SnapshotLayoutElementCandidate,
  document: SnapshotDocument,
  elements: Map<number, SnapshotLayoutElementCandidate>,
  renderBlockedMemo: Map<number, boolean>,
): boolean {
  if (element.bounds.width <= 0 || element.bounds.height <= 0) return false;
  if (element.styles.get("display") === "none") return false;
  const visibility = element.styles.get("visibility");
  if (visibility === "hidden" || visibility === "collapse") return false;
  return !isSnapshotElementRenderBlocked(element, document, elements, renderBlockedMemo);
}

function isSnapshotElementRenderBlocked(
  element: SnapshotLayoutElementCandidate,
  document: SnapshotDocument,
  elements: Map<number, SnapshotLayoutElementCandidate>,
  memo: Map<number, boolean>,
): boolean {
  const cached = memo.get(element.nodeIndex);
  if (cached !== undefined) return cached;

  const opacity = Number(element.styles.get("opacity") ?? "1");
  const blocksSelf = opacity === 0 || element.styles.get("content-visibility") === "hidden";
  const parent = findNearestSnapshotElement(readParentIndex(document, element.nodeIndex), document, elements);
  const blocked = blocksSelf || (parent ? isSnapshotElementRenderBlocked(parent, document, elements, memo) : false);
  memo.set(element.nodeIndex, blocked);
  return blocked;
}

function isUsableSnapshotText(text: SnapshotLayoutTextCandidate): boolean {
  return normalizeText(text.text).length > 0 && text.bounds.width > 0 && text.bounds.height > 0;
}

function isSnapshotTextRenderBlocked(
  text: SnapshotLayoutTextCandidate,
  document: SnapshotDocument,
  elements: Map<number, SnapshotLayoutElementCandidate>,
  memo: Map<number, boolean>,
): boolean {
  const nearestElement = findNearestSnapshotElement(readParentIndex(document, text.nodeIndex), document, elements);
  if (!nearestElement) return true;
  const visibility = nearestElement.styles.get("visibility");
  return visibility === "hidden" || visibility === "collapse" || isSnapshotElementRenderBlocked(nearestElement, document, elements, memo);
}

function findNearestRetainedElement(
  startNodeIndex: number | null,
  elements: Map<number, DecodedLayoutElement>,
  retained: Map<number, RetainedLayoutElement>,
): number | null {
  let current = startNodeIndex;
  const seen = new Set<number>();
  while (current !== null && !seen.has(current)) {
    if (retained.has(current)) return current;
    seen.add(current);
    current = elements.get(current)?.parentElementNodeIndex ?? null;
  }
  return null;
}

function findNearestSnapshotElement(
  startNodeIndex: number | null,
  document: SnapshotDocument,
  elements: Map<number, SnapshotLayoutElementCandidate>,
): SnapshotLayoutElementCandidate | undefined {
  let current = startNodeIndex;
  const seen = new Set<number>();
  while (current !== null && !seen.has(current)) {
    const element = elements.get(current);
    if (element) return element;
    seen.add(current);
    current = readParentIndex(document, current);
  }
  return undefined;
}

function findNearestRetainedSnapshotElement(
  startNodeIndex: number | null,
  document: SnapshotDocument,
  retained: Map<number, SnapshotLayoutElementCandidate>,
): number | null {
  let current = startNodeIndex;
  const seen = new Set<number>();
  while (current !== null && !seen.has(current)) {
    if (retained.has(current)) return current;
    seen.add(current);
    current = readParentIndex(document, current);
  }
  return null;
}

function findNearestElementNodeIndex(
  startNodeIndex: number | null,
  document: SnapshotDocument,
  elementNodeIndexes: Set<number>,
): number | null {
  let current = startNodeIndex;
  while (current !== null) {
    if (elementNodeIndexes.has(current)) return current;
    current = readParentIndex(document, current);
  }
  return null;
}

function readParentIndex(document: SnapshotDocument, nodeIndex: number): number | null {
  const parentIndex = document.nodes.parentIndex?.[nodeIndex];
  return parentIndex === undefined || parentIndex < 0 ? null : parentIndex;
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

function isNativeInteractive(element: Pick<DecodedLayoutElement, "attributes" | "tagName">): boolean {
  if (INTERACTIVE_TAGS.has(element.tagName)) return true;
  return element.tagName === "a" && element.attributes.has("href");
}

function isScrollable(styles: ReadonlyMap<string, string>): boolean {
  const values = [styles.get("overflow"), styles.get("overflow-x"), styles.get("overflow-y")];
  return values.some((value) => value === "auto" || value === "scroll");
}

function parseZIndex(value: string | undefined): number | undefined {
  if (!value || value === "auto") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
