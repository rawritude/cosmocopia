import type { RGB } from './palette';

// A tiny pixel canvas — RGBA flat buffer, draw operations in pixel coords.

export class PixelCanvas {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 4);
  }

  fill(rgb: RGB, alpha = 255) {
    for (let i = 0; i < this.data.length; i += 4) {
      this.data[i] = rgb[0];
      this.data[i + 1] = rgb[1];
      this.data[i + 2] = rgb[2];
      this.data[i + 3] = alpha;
    }
  }

  set(x: number, y: number, rgb: RGB, alpha = 255) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 4;
    if (alpha === 255) {
      this.data[i] = rgb[0];
      this.data[i + 1] = rgb[1];
      this.data[i + 2] = rgb[2];
      this.data[i + 3] = 255;
      return;
    }
    // Alpha-blend over existing.
    const a = alpha / 255;
    this.data[i] = Math.round(rgb[0] * a + this.data[i] * (1 - a));
    this.data[i + 1] = Math.round(rgb[1] * a + this.data[i + 1] * (1 - a));
    this.data[i + 2] = Math.round(rgb[2] * a + this.data[i + 2] * (1 - a));
    this.data[i + 3] = Math.min(255, this.data[i + 3] + alpha);
  }

  /// Filled disk centered at (cx, cy) with radius r. `paint` returns a color
  /// or null per (x, y) given the normalized direction (dx, dy) and squared
  /// distance d2 to the center.
  disk(
    cx: number,
    cy: number,
    r: number,
    paint: (dx: number, dy: number, d2: number) => RGB | null,
  ) {
    const r2 = r * r;
    for (let y = -r; y <= r; y++) {
      const yy = y * y;
      for (let x = -r; x <= r; x++) {
        const d2 = x * x + yy;
        if (d2 > r2) continue;
        const c = paint(x, y, d2);
        if (c) this.set(cx + x, cy + y, c);
      }
    }
  }

  ring(cx: number, cy: number, r: number, thickness: number, rgb: RGB, alpha = 255) {
    const r2 = r * r;
    const inner = (r - thickness) * (r - thickness);
    for (let y = -r; y <= r; y++) {
      for (let x = -r; x <= r; x++) {
        const d2 = x * x + y * y;
        if (d2 <= r2 && d2 >= inner) this.set(cx + x, cy + y, rgb, alpha);
      }
    }
  }

  ellipseStroke(cx: number, cy: number, rx: number, ry: number, rgb: RGB, alpha = 255) {
    // Midpoint ellipse — outline only.
    const stamp = (x: number, y: number) => {
      this.set(cx + x, cy + y, rgb, alpha);
      this.set(cx - x, cy + y, rgb, alpha);
      this.set(cx + x, cy - y, rgb, alpha);
      this.set(cx - x, cy - y, rgb, alpha);
    };
    let x = 0;
    let y = ry;
    const rx2 = rx * rx;
    const ry2 = ry * ry;
    let dx = 2 * ry2 * x;
    let dy = 2 * rx2 * y;
    let d1 = ry2 - rx2 * ry + 0.25 * rx2;
    while (dx < dy) {
      stamp(x, y);
      x++;
      dx += 2 * ry2;
      if (d1 < 0) {
        d1 += dx + ry2;
      } else {
        y--;
        dy -= 2 * rx2;
        d1 += dx - dy + ry2;
      }
    }
    let d2 = ry2 * (x + 0.5) ** 2 + rx2 * (y - 1) ** 2 - rx2 * ry2;
    while (y >= 0) {
      stamp(x, y);
      y--;
      dy -= 2 * rx2;
      if (d2 > 0) {
        d2 += rx2 - dy;
      } else {
        x++;
        dx += 2 * ry2;
        d2 += dx - dy + rx2;
      }
    }
  }
}
