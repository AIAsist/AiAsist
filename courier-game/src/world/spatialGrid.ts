// Uniform grid index: items are registered in every cell their bounding box touches.

export class SpatialGrid {
  readonly cols: number;
  readonly rows: number;
  private readonly cells: (number[] | undefined)[];

  constructor(
    readonly minX: number,
    readonly minY: number,
    maxX: number,
    maxY: number,
    readonly cell: number,
  ) {
    this.cols = Math.max(1, Math.ceil((maxX - minX) / cell));
    this.rows = Math.max(1, Math.ceil((maxY - minY) / cell));
    this.cells = new Array(this.cols * this.rows);
  }

  private cx(x: number): number {
    const c = Math.floor((x - this.minX) / this.cell);
    return c < 0 ? 0 : c >= this.cols ? this.cols - 1 : c;
  }

  private cy(y: number): number {
    const r = Math.floor((y - this.minY) / this.cell);
    return r < 0 ? 0 : r >= this.rows ? this.rows - 1 : r;
  }

  insert(id: number, x0: number, y0: number, x1: number, y1: number): void {
    const c0 = this.cx(Math.min(x0, x1));
    const c1 = this.cx(Math.max(x0, x1));
    const r0 = this.cy(Math.min(y0, y1));
    const r1 = this.cy(Math.max(y0, y1));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const k = r * this.cols + c;
        (this.cells[k] ??= []).push(id);
      }
    }
  }

  /** Items registered in the cell containing (x, y). */
  at(x: number, y: number): readonly number[] {
    return this.cells[this.cy(y) * this.cols + this.cx(x)] ?? EMPTY;
  }

  /** Calls `fn` for every item in cells overlapping the rectangle (an item may be visited more than once). */
  forEachIn(x0: number, y0: number, x1: number, y1: number, fn: (id: number) => void): void {
    const c0 = this.cx(x0);
    const c1 = this.cx(x1);
    const r0 = this.cy(y0);
    const r1 = this.cy(y1);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const list = this.cells[r * this.cols + c];
        if (list) for (const id of list) fn(id);
      }
    }
  }
}

const EMPTY: readonly number[] = [];
