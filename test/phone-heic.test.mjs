import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom } from "./dom/harness.mjs";

// An iPhone photo picked from Files is HEIC, which only a Mac could turn
// into something agents read (parity audit #36): the phone makes it a JPEG,
// at most 16 million pixels, and sends anything it can't read as it is.
let dom, phoneJpeg;
before(async () => {
  dom = await startDom();
  ({ phoneJpeg } = await dom.load("/src/agent-sessions.ts"));
});
after(async () => dom?.close());

const fakes = (width, height, { fail = false } = {}) => {
  const drawn = [];
  const surface = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: (_, x, y, w, h) => drawn.push([w, h]) }),
    toBlob: (done, type, quality) => done(new Blob(["jpeg"], { type })),
  };
  return {
    drawn,
    surface,
    decode: async () => {
      if (fail) throw Error("This browser can't read HEIC");
      return { width, height, close() {} };
    },
    canvas: () => surface,
  };
};

test("a HEIC photo goes as a JPEG, scaled to 16 million pixels at most; others go as they are", async () => {
  const heic = new Blob(["heic"], { type: "image/heic" });
  const small = fakes(3024, 4032);
  const sent = await phoneJpeg(heic, "IMG_0042.HEIC", small);
  assert.equal(sent.name, "IMG_0042.jpg");
  assert.equal(sent.file.type, "image/jpeg");
  assert.deepEqual(small.drawn, [[3024, 4032]], "12 MP: full size");
  const big = fakes(6048, 8064);
  await phoneJpeg(new Blob(["heic"], { type: "" }), "IMG_0043.heif", big);
  const [[w, h]] = big.drawn;
  assert.ok(w * h <= 16_000_000 && w * h > 15_900_000, `${w}×${h}`);
  assert.equal(Math.round((w / h) * 1000), Math.round((6048 / 8064) * 1000), "same shape");
  // Can't be read here: sent as it is (a Mac converts it).
  const kept = await phoneJpeg(heic, "IMG_0044.heic", fakes(1, 1, { fail: true }));
  assert.equal(kept.file, heic);
  assert.equal(kept.name, "IMG_0044.heic");
  // Not HEIC: untouched, never decoded.
  const png = new Blob(["png"], { type: "image/png" });
  const untouched = fakes(1, 1);
  assert.deepEqual(await phoneJpeg(png, "shot.png", untouched), { file: png, name: "shot.png" });
  assert.deepEqual(untouched.drawn, []);
});
