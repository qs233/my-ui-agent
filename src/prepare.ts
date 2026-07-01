import { COMPUTED_STYLES } from "./snapshot.js";
import { appendText, normalizeText, truncateText } from "./text.js";
import type {
  Bounds,
  DomNodeRecord,
  SnapshotDocument,
  SnapshotOptions,
  SnapshotResponse,
} from "./types.js";

const INTERACTIVE_TAGS = new Set(["button", "input", "select", "textarea", "summary", "option"]);
const VIEWPORT_OVERFLOW_SCOPE = "viewport";

interface LayoutElementMeta {
  nodeIndex: number;
  backendNodeId: number;
  parentElementNodeIndex: number | null;
  tagName: string;
  attributes: ReadonlyMap<string, string>;
  styles: ReadonlyMap<string, string>;
  bounds: Bounds;
  paintOrder: number;
  position: string;
  overflowX: string;
  overflowY: string;
  createsOverflowScope: boolean;
  ownedOverflowScopeId?: string;
  boxOverflowScopeId: string;
  normallyRetained: boolean;
  retained: boolean;
  isInvisibleOverflowBoundary: boolean;
}

export function visibleNodesFromSnapshot(snapshot: SnapshotResponse, options: SnapshotOptions = {}): DomNodeRecord[] {
  const document = snapshot.documents[0];
  if (!document) return [];

  const textMaxLength = options.textMaxLength ?? 80;
  const viewportFilter = resolveViewportFilter(options);
  const baseClip = createBaseVisibleClip(viewportFilter);
  const { elements, texts } = collectSnapshotLayoutCandidates(document, snapshot.strings);
  const metas = buildSnapshotElementMetas(document, elements);
  const renderBlockedMemo = new Map<number, boolean>();
  const visibleClipMemo = new Map<number | null, VisibleClip>();

  for (const meta of metas.values()) {
    const element = elements.get(meta.nodeIndex);
    if (!element) continue;
    meta.normallyRetained = (
      isRetainedSnapshotElement(element, document, elements, renderBlockedMemo) &&
      isInsideVisibleClip(
        element.bounds,
        resolveSnapshotVisibleClip(readParentIndex(document, element.nodeIndex), document, elements, baseClip, visibleClipMemo),
      )
    );
    meta.retained = meta.normallyRetained;
  }
  retainStructuralOverflowBoundaries(metas);

  const textByOwner = new Map<number, string>();
  for (const text of texts) {
    if (!isUsableSnapshotText(text)) continue;
    if (!isInsideVisibleClip(
      text.bounds,
      resolveSnapshotVisibleClip(readParentIndex(document, text.nodeIndex), document, elements, baseClip, visibleClipMemo),
    )) continue;
    if (isSnapshotTextRenderBlocked(text, document, elements, renderBlockedMemo)) continue;

    const ownerNodeIndex = findNearestRetainedSnapshotElement(
      readParentIndex(document, text.nodeIndex),
      document,
      metas,
    );
    if (ownerNodeIndex === null) continue;
    textByOwner.set(ownerNodeIndex, appendText(textByOwner.get(ownerNodeIndex) ?? "", text.text, textMaxLength));
  }

  const rawNodes: DomNodeRecord[] = [];
  for (const element of metas.values()) {
    if (!element.retained) continue;
    const parentNodeIndex = findNearestRetainedSnapshotElement(
      readParentIndex(document, element.nodeIndex),
      document,
      metas,
    );
    const parent = parentNodeIndex === null ? undefined : metas.get(parentNodeIndex);

    rawNodes.push(toDomNodeRecord(element, parent, textByOwner.get(element.nodeIndex) ?? "", textMaxLength));
  }

  populateChildIds(rawNodes);
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

function buildSnapshotElementMetas(
  document: SnapshotDocument,
  elements: ReadonlyMap<number, SnapshotLayoutElementCandidate>,
): Map<number, LayoutElementMeta> {
  const metas = new Map<number, LayoutElementMeta>();
  for (const element of elements.values()) {
    const parent = findNearestSnapshotElement(readParentIndex(document, element.nodeIndex), document, elements);
    metas.set(element.nodeIndex, createElementMeta(element, parent?.nodeIndex ?? null));
  }
  resolveOverflowScopes(metas);
  return metas;
}

function createElementMeta(
  element: Pick<SnapshotLayoutElementCandidate, "nodeIndex" | "backendNodeId" | "tagName" | "attributes" | "styles" | "bounds" | "paintOrder">,
  parentElementNodeIndex: number | null,
): LayoutElementMeta {
  const { overflowX, overflowY } = resolveOverflowStyles(element.styles);
  const createsOverflowScope = isOverflowScopeValue(overflowX) || isOverflowScopeValue(overflowY);
  return {
    nodeIndex: element.nodeIndex,
    backendNodeId: element.backendNodeId,
    parentElementNodeIndex,
    tagName: element.tagName,
    attributes: element.attributes,
    styles: element.styles,
    bounds: element.bounds,
    paintOrder: element.paintOrder,
    position: element.styles.get("position") || "static",
    overflowX,
    overflowY,
    createsOverflowScope,
    ownedOverflowScopeId: createsOverflowScope ? overflowScopeId(element.backendNodeId) : undefined,
    boxOverflowScopeId: VIEWPORT_OVERFLOW_SCOPE,
    normallyRetained: false,
    retained: false,
    isInvisibleOverflowBoundary: false,
  };
}

function resolveOverflowScopes(metas: Map<number, LayoutElementMeta>): void {
  for (const meta of metas.values()) {
    meta.boxOverflowScopeId = resolveBoxOverflowScope(meta, metas);
  }
}

function resolveBoxOverflowScope(
  meta: LayoutElementMeta,
  metas: ReadonlyMap<number, LayoutElementMeta>,
): string {
  if (meta.position === "fixed") {
    const containingBlock = findFixedContainingBlock(meta, metas);
    if (!containingBlock) return VIEWPORT_OVERFLOW_SCOPE;
    return resolveEffectiveOverflowScopeFromContainingBlock(meta, containingBlock, metas);
  }

  if (meta.position === "absolute") {
    const containingBlock = findAbsoluteContainingBlock(meta, metas);
    if (containingBlock) return resolveEffectiveOverflowScopeFromContainingBlock(meta, containingBlock, metas);
  }

  return resolveNearestOverflowAncestorScope(meta, metas);
}

function resolveNearestOverflowAncestorScope(
  meta: LayoutElementMeta,
  metas: ReadonlyMap<number, LayoutElementMeta>,
): string {
  let current = meta.parentElementNodeIndex === null ? undefined : metas.get(meta.parentElementNodeIndex);
  while (current) {
    if (current.ownedOverflowScopeId) return current.ownedOverflowScopeId;
    current = current.parentElementNodeIndex === null ? undefined : metas.get(current.parentElementNodeIndex);
  }
  return VIEWPORT_OVERFLOW_SCOPE;
}

function resolveEffectiveOverflowScopeFromContainingBlock(
  meta: LayoutElementMeta,
  containingBlock: LayoutElementMeta,
  metas: ReadonlyMap<number, LayoutElementMeta>,
): string {
  let current = meta.parentElementNodeIndex === null ? undefined : metas.get(meta.parentElementNodeIndex);
  while (current) {
    if (
      current.ownedOverflowScopeId &&
      (current.nodeIndex === containingBlock.nodeIndex || isAncestorMeta(current, containingBlock, metas))
    ) {
      return current.ownedOverflowScopeId;
    }
    current = current.parentElementNodeIndex === null ? undefined : metas.get(current.parentElementNodeIndex);
  }
  return VIEWPORT_OVERFLOW_SCOPE;
}

function findAbsoluteContainingBlock(
  meta: LayoutElementMeta,
  metas: ReadonlyMap<number, LayoutElementMeta>,
): LayoutElementMeta | undefined {
  let current = meta.parentElementNodeIndex === null ? undefined : metas.get(meta.parentElementNodeIndex);
  while (current) {
    if (current.position !== "static") return current;
    current = current.parentElementNodeIndex === null ? undefined : metas.get(current.parentElementNodeIndex);
  }
  return undefined;
}

function findFixedContainingBlock(
  meta: LayoutElementMeta,
  metas: ReadonlyMap<number, LayoutElementMeta>,
): LayoutElementMeta | undefined {
  let current = meta.parentElementNodeIndex === null ? undefined : metas.get(meta.parentElementNodeIndex);
  while (current) {
    if (createsFixedContainingBlock(current)) return current;
    current = current.parentElementNodeIndex === null ? undefined : metas.get(current.parentElementNodeIndex);
  }
  return undefined;
}

function createsFixedContainingBlock(meta: LayoutElementMeta): boolean {
  return (
    hasNonNoneStyle(meta.styles.get("transform")) ||
    hasNonNoneStyle(meta.styles.get("filter")) ||
    hasNonNoneStyle(meta.styles.get("perspective")) ||
    containsAnyCssToken(meta.styles.get("contain"), ["layout", "paint", "strict", "content"]) ||
    containsAnyCssToken(meta.styles.get("will-change"), ["transform", "filter", "perspective"])
  );
}

function retainStructuralOverflowBoundaries(metas: Map<number, LayoutElementMeta>): void {
  const normallyRetainedScopesByAncestor = new Map<number, Set<string>>();

  for (const meta of metas.values()) {
    if (!meta.normallyRetained) continue;
    let current = meta.parentElementNodeIndex === null ? undefined : metas.get(meta.parentElementNodeIndex);
    while (current) {
      let scopes = normallyRetainedScopesByAncestor.get(current.nodeIndex);
      if (!scopes) {
        scopes = new Set();
        normallyRetainedScopesByAncestor.set(current.nodeIndex, scopes);
      }
      scopes.add(meta.boxOverflowScopeId);
      current = current.parentElementNodeIndex === null ? undefined : metas.get(current.parentElementNodeIndex);
    }
  }

  for (const meta of metas.values()) {
    if (
      !meta.retained &&
      shouldRetainStructuralOverflowBoundary(meta) &&
      meta.ownedOverflowScopeId &&
      normallyRetainedScopesByAncestor.get(meta.nodeIndex)?.has(meta.ownedOverflowScopeId)
    ) {
      meta.retained = true;
      meta.isInvisibleOverflowBoundary = true;
    }
  }
}

function shouldRetainStructuralOverflowBoundary(meta: LayoutElementMeta): boolean {
  return (
    meta.createsOverflowScope &&
    meta.bounds.width > 0 &&
    meta.bounds.height > 0 &&
    meta.styles.get("display") !== "none" &&
    meta.styles.get("visibility") === "hidden" &&
    !isZeroOpacity(meta.styles.get("opacity")) &&
    meta.styles.get("content-visibility") !== "hidden"
  );
}

function toDomNodeRecord(
  element: LayoutElementMeta,
  parent: LayoutElementMeta | undefined,
  text: string,
  textMaxLength: number,
): DomNodeRecord {
  return {
    id: String(element.backendNodeId),
    parentId: parent ? String(parent.backendNodeId) : null,
    childIds: [],
    bounds: { ...element.bounds },
    tagName: element.tagName,
    className: truncateText(element.attributes.get("class") ?? "", textMaxLength),
    name: truncateText(element.attributes.get("name") ?? "", textMaxLength),
    text: element.isInvisibleOverflowBoundary ? "" : text,
    ...element.bounds,
    paintOrder: element.paintOrder,
    position: element.position,
    zIndex: parseZIndex(element.styles.get("z-index")),
    isInteractive: isNativeInteractive(element),
    maybeScrollRegion: element.createsOverflowScope && (isMaybeScrollRegionValue(element.overflowX) || isMaybeScrollRegionValue(element.overflowY)),
    overflowX: element.overflowX,
    overflowY: element.overflowY,
    boxOverflowScopeId: element.boxOverflowScopeId,
    ownedOverflowScopeId: element.ownedOverflowScopeId,
    isVisible: element.normallyRetained,
    isInvisibleOverflowBoundary: element.isInvisibleOverflowBoundary,
  };
}

interface ResolvedViewportFilter {
  viewport: Bounds;
  margin: number;
}

interface AxisClip {
  min: number;
  max: number;
}

interface AxisAwareClip {
  x?: AxisClip;
  y?: AxisClip;
}

type VisibleClip = AxisAwareClip | undefined;

function resolveViewportFilter(options: SnapshotOptions): ResolvedViewportFilter | undefined {
  const filter = options.viewportFilter;
  if (!filter || filter === true) return undefined;
  if (!filter.viewport) return undefined;
  return {
    viewport: filter.viewport,
    margin: filter.margin ?? 0,
  };
}

function createBaseVisibleClip(filter: ResolvedViewportFilter | undefined): VisibleClip {
  if (!filter) return undefined;
  return boundsToVisibleClip(expandBounds(filter.viewport, filter.margin));
}

function isInsideVisibleClip(bounds: Bounds, clip: VisibleClip): boolean {
  if (!clip) return true;
  const width = clip.x ? computeAxisIntersection(bounds.x, bounds.x + bounds.width, clip.x) : bounds.width;
  const height = clip.y ? computeAxisIntersection(bounds.y, bounds.y + bounds.height, clip.y) : bounds.height;
  return width * height > 1;
}

function resolveSnapshotVisibleClip(
  startNodeIndex: number | null,
  document: SnapshotDocument,
  elements: Map<number, SnapshotLayoutElementCandidate>,
  baseClip: VisibleClip,
  memo: Map<number | null, VisibleClip>,
): VisibleClip {
  if (memo.has(startNodeIndex)) return memo.get(startNodeIndex);

  const parent = startNodeIndex === null ? undefined : elements.get(startNodeIndex);
  const parentClip = parent
    ? resolveSnapshotVisibleClip(readParentIndex(document, parent.nodeIndex), document, elements, baseClip, memo)
    : baseClip;
  const clip = parent ? applyClippingAncestor(parentClip, parent.bounds, parent.styles) : parentClip;
  memo.set(startNodeIndex, clip);
  return clip;
}

function applyClippingAncestor(
  parentClip: VisibleClip,
  bounds: Bounds,
  styles: ReadonlyMap<string, string>,
): VisibleClip {
  const axes = getClippingAxes(styles);
  if (!axes.x && !axes.y) return parentClip;

  const clip: AxisAwareClip = { ...(parentClip ?? {}) };
  if (axes.x) clip.x = intersectAxisClip(parentClip?.x, { min: bounds.x, max: bounds.x + bounds.width });
  if (axes.y) clip.y = intersectAxisClip(parentClip?.y, { min: bounds.y, max: bounds.y + bounds.height });
  return clip;
}

function getClippingAxes(styles: ReadonlyMap<string, string>): { x: boolean; y: boolean } {
  const overflow = styles.get("overflow");
  const overflowX = styles.get("overflow-x") || overflow;
  const overflowY = styles.get("overflow-y") || overflow;
  return {
    x: isClippingOverflow(overflow) || isClippingOverflow(overflowX),
    y: isClippingOverflow(overflow) || isClippingOverflow(overflowY),
  };
}

function isClippingOverflow(value: string | undefined): boolean {
  return value === "auto" || value === "scroll" || value === "hidden" || value === "clip";
}

function boundsToVisibleClip(bounds: Bounds): AxisAwareClip {
  return {
    x: { min: bounds.x, max: bounds.x + bounds.width },
    y: { min: bounds.y, max: bounds.y + bounds.height },
  };
}

function intersectAxisClip(current: AxisClip | undefined, next: AxisClip): AxisClip {
  if (!current) return next;
  return {
    min: Math.max(current.min, next.min),
    max: Math.min(current.max, next.max),
  };
}

function computeAxisIntersection(start: number, end: number, clip: AxisClip): number {
  return Math.max(0, Math.min(end, clip.max) - Math.max(start, clip.min));
}

function expandBounds(bounds: Bounds, margin: number): Bounds {
  const safeMargin = Number.isFinite(margin) ? Math.max(0, margin) : 0;
  const width = bounds.width + safeMargin * 2;
  const height = bounds.height + safeMargin * 2;
  return {
    x: bounds.x - safeMargin,
    y: bounds.y - safeMargin,
    width,
    height,
    area: Math.max(0, width * height),
  };
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

function decodeBounds(encoded: number[] | undefined): Bounds | null {
  if (!encoded || encoded.length < 4) return null;
  const [x, y, width, height] = encoded.map(Number);
  if (![x, y, width, height].every(Number.isFinite)) return null;
  return { x, y, width, height, area: Math.max(0, width * height) };
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

  const blocksSelf = isZeroOpacity(element.styles.get("opacity")) || element.styles.get("content-visibility") === "hidden";
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

function findNearestSnapshotElement(
  startNodeIndex: number | null,
  document: SnapshotDocument,
  elements: ReadonlyMap<number, SnapshotLayoutElementCandidate>,
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
  metas: ReadonlyMap<number, LayoutElementMeta>,
): number | null {
  let current = startNodeIndex;
  const seen = new Set<number>();
  while (current !== null && !seen.has(current)) {
    if (metas.get(current)?.retained) return current;
    seen.add(current);
    current = readParentIndex(document, current);
  }
  return null;
}

function populateChildIds(nodes: DomNodeRecord[]): void {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) node.childIds = [];

  for (const node of nodes) {
    if (!node.parentId) continue;
    byId.get(node.parentId)?.childIds.push(node.id);
  }
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

function isNativeInteractive(element: Pick<SnapshotLayoutElementCandidate, "attributes" | "tagName">): boolean {
  if (INTERACTIVE_TAGS.has(element.tagName)) return true;
  return element.tagName === "a" && element.attributes.has("href");
}

function resolveOverflowStyles(styles: ReadonlyMap<string, string>): { overflowX: string; overflowY: string } {
  const overflow = styles.get("overflow") || "visible";
  return {
    overflowX: styles.get("overflow-x") || overflow,
    overflowY: styles.get("overflow-y") || overflow,
  };
}

function isOverflowScopeValue(value: string | undefined): boolean {
  return value === "auto" || value === "scroll" || value === "hidden" || value === "clip";
}

function isMaybeScrollRegionValue(value: string | undefined): boolean {
  return value === "auto" || value === "scroll" || value === "hidden";
}

function overflowScopeId(backendNodeId: number): string {
  return `overflow:${backendNodeId}`;
}

function isAncestorMeta(
  ancestor: LayoutElementMeta,
  node: LayoutElementMeta,
  metas: ReadonlyMap<number, LayoutElementMeta>,
): boolean {
  let current = node.parentElementNodeIndex === null ? undefined : metas.get(node.parentElementNodeIndex);
  while (current) {
    if (current.nodeIndex === ancestor.nodeIndex) return true;
    current = current.parentElementNodeIndex === null ? undefined : metas.get(current.parentElementNodeIndex);
  }
  return false;
}

function hasNonNoneStyle(value: string | undefined): boolean {
  return Boolean(value && value !== "none");
}

function containsAnyCssToken(value: string | undefined, tokens: readonly string[]): boolean {
  if (!value) return false;
  const parts = value.split(/[\s,]+/).filter(Boolean);
  return tokens.some((token) => parts.includes(token));
}

function isZeroOpacity(value: string | undefined): boolean {
  const opacity = Number(value ?? "1");
  return Number.isFinite(opacity) && opacity === 0;
}

function parseZIndex(value: string | undefined): number | undefined {
  if (!value || value === "auto") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
