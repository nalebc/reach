# Reach README demo

The README animation shows the real React interface with isolated sample data.
It does not run a companion, join a tailnet, invoke Codex, or open a real terminal.
Mutating API requests are rejected. The capture uses a separate localhost origin;
its dummy session never replaces credentials on a real Reach origin.

## Preview

After installing development dependencies, run from the repository root:

```sh
node scripts/demo/start.mjs
```

Open `http://127.0.0.1:5201` and use a 390 × 844 browser viewport. The demo uses
Home Mac, My iPhone, My iPad, and Alex as fictional devices and people. This
fixture is for local screenshots only; do not deploy it as an operational Reach
frontend. The Screen and terminal transports are not part of this fixture.

## Capture and render

Capture the visible viewport using browser screenshot tools. Save these names
in a local capture directory:

1. `home.png` — Home, before scrolling. Optionally capture a short sequence as
   `home-000.png` through `home-031.png` for the actual companion motion.
2. `files.png` — Files.
3. `codex.png` — Codex conversation inbox.
4. `chat.png` — Open “Build a better workspace.”
5. `explore.png` — More.
6. `settings.png` — More → Settings → General.

Keep capture files outside the repository. Compose the GIF and poster using
Python 3 and Pillow (a demo authoring dependency, not a Reach runtime dependency):

```sh
python3 scripts/demo/render.py /path/to/captures docs/media --frames /tmp/reach-demo-frames
```

The renderer adds captions and transitions around the screenshots; it does not
alter the interface shown inside the phone. All scenes are explicitly labeled
“UI walkthrough · sample data.” Arial is used when available, with a DejaVu Sans
fallback. No font files are distributed.

On macOS, optionally export the same frames to H.264 MP4 using Apple's media
frameworks and a Swift toolchain. The output path must not already exist:

```sh
/usr/bin/xcrun --toolchain XcodeDefault swift scripts/demo/encode.swift /tmp/reach-demo-frames /tmp/reach-demo.mp4
cp /tmp/reach-demo.mp4 docs/media/reach-demo.mp4
```

Inspect the poster, every scene, and the exported video before replacing README
assets. Update the duration in README if the sequence changes. This tour is not
evidence of remote-stream frame rate, end-to-end latency, or device compatibility.
