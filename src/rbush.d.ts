declare module "rbush" {
  export interface BBox {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  }

  export default class RBush<T extends BBox = BBox> {
    constructor(maxEntries?: number);
    insert(item: T): this;
    search(box: BBox): T[];
    clear(): this;
  }
}
