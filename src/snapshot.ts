import type { Page } from "playwright";
import type { SnapshotResponse } from "./types.js";

export const COMPUTED_STYLES = [
  "display",
  "visibility",
  "opacity",
  "content-visibility",
  "position",
  "z-index",
  "overflow",
  "overflow-x",
  "overflow-y",
  "pointer-events",
  "cursor",
  "transform",
  "filter",
  "perspective",
  "contain",
  "will-change",
] as const;

export async function captureSnapshot(page: Page): Promise<SnapshotResponse> {
  const session = await page.context().newCDPSession(page);
  return (await session.send("DOMSnapshot.captureSnapshot", {
    computedStyles: [...COMPUTED_STYLES],
    includePaintOrder: true,
  })) as SnapshotResponse;
}
