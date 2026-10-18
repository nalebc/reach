type Point = { x: number; y: number };
type Image = { width: number; height: number };
export const DOUBLE_TAP_MS = 350;
const pairing = (radius: number, image: Image, previous: Image) => ({
  x: Math.min(0.1, radius / Math.max(1, image.width, previous.width)),
  y: Math.min(0.1, radius / Math.max(1, image.height, previous.height)),
});

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
    client?: Point;
  } | null = null;
  reset(clickId?: number) {
    if (clickId === undefined || this.previous?.clickId === clickId)
      this.previous = null;
  }
  // client: where the finger touched the page, when known. A double-tap is
  // the same spot on the glass twice: the picture can move between the two
  // taps (the first opened the keyboard and the view made room for it), too
  // fast for anyone to aim anew. The pair then goes to the first tap's point.
  next(
    point: Point | null,
    at: number,
    pointer: string,
    image: Image,
    client?: Point,
  ) {
    if (!point) {
      this.reset();
      return undefined;
    }
    const previous = this.previous;
    const onGlass = !!(client && previous?.client);
    const remote =
      previous && point
        ? Math.hypot(
            (point.x - previous.point.x) * Math.max(image.width, previous.image.width),
            (point.y - previous.point.y) * Math.max(image.height, previous.image.height),
          )
        : Infinity;
    // The same spot on the glass, or on the computer's picture (the finger
    // followed it): either is a pair.
    const distance = onGlass && point
      ? Math.min(remote, Math.hypot(client!.x - previous!.client!.x, client!.y - previous!.client!.y))
      : remote;
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
        // Each tap keeps its own point, unless the picture moved under the
        // finger between them: then where the first one aimed.
        point: onGlass && remote > radius ? previous.point : point,
        // The same tolerance for the computer, in shares of its display: a
        // host comparing in its own pixels would refuse a finger's drift.
        pair: pairing(radius, image, previous.image),
      };
    }
    this.id = (this.id % 2147483647) + 1;
    this.previous = {
      point,
      at,
      pointer,
      clickId: this.id,
      image: { ...image },
      ...(client && { client: { ...client } }),
    };
    return { clickId: this.id, clickState: 1, point };
  }
}
