type Point = { x: number; y: number };
type Image = { width: number; height: number };
export const DOUBLE_TAP_MS = 350;

// Each tap still sends one press/release. The second carries the first tap's
// identity so the host can preserve click timing. Each tap keeps its own point.
export class TapClicks {
  private id = 0;
  private previous: {
    point: Point;
    at: number;
    pointer: string;
    clickId: number;
    image: Image;
  } | null = null;
  reset(clickId?: number) {
    if (clickId === undefined || this.previous?.clickId === clickId)
      this.previous = null;
  }
  next(
    point: Point | null,
    at: number,
    pointer: string,
    image: Image,
  ) {
    if (!point) {
      this.reset();
      return undefined;
    }
    const previous = this.previous;
    const distance =
      previous && point
        ? Math.hypot(
            (point.x - previous.point.x) * Math.max(image.width, previous.image.width),
            (point.y - previous.point.y) * Math.max(image.height, previous.image.height),
          )
        : Infinity;
    // Fingers tolerate a little drift; mouse and pen remain precise. Compare
    // remote points in CSS pixels, using the larger image when it resizes so
    // shrinking the picture cannot merge taps on different remote targets.
    const radius = pointer === "touch" ? 8 : 4;
    if (
      previous &&
      previous.pointer === pointer &&
      at >= previous.at &&
      at - previous.at <= DOUBLE_TAP_MS &&
      distance <= radius
    ) {
      this.reset();
      return {
        clickId: previous.clickId,
        clickState: 2,
        point,
      };
    }
    this.id = (this.id % 2147483647) + 1;
    this.previous = {
      point,
      at,
      pointer,
      clickId: this.id,
      image: { ...image },
    };
    return { clickId: this.id, clickState: 1, point };
  }
}
