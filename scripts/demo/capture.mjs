// Captures the README tour from the sample-data demo (scripts/demo/start.mjs):
// six phone-sized screenshots, named as render.py expects. Needs Google Chrome
// and playwright-core (`npm i --no-save playwright-core`), a demo authoring
// tool, not a Reach dependency. The Screen scene shows sample-desktop.html,
// answered on the page's own screen socket: no real screen is ever captured.
//
//   node scripts/demo/start.mjs                  # in one terminal
//   node scripts/demo/capture.mjs /tmp/captures  # in another
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const out = process.argv[2];
if (!out) throw Error("Usage: node scripts/demo/capture.mjs CAPTURE_DIRECTORY");
fs.mkdirSync(out, { recursive: true });
const base = process.env.DEMO_URL || "http://127.0.0.1:5201";
const here = path.dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch({ channel: "chrome", headless: true });

// The sample desktop, as the Mac's screen would send it.
const desk = await browser.newPage({ viewport: { width: 1512, height: 982 } });
await desk.goto(`file://${path.join(here, "sample-desktop.html")}`);
const desktop = (await desk.screenshot({ type: "jpeg", quality: 88 })).toString(
  "base64",
);
await desk.close();

async function scene(name, url, steps = [], { screen = false } = {}) {
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  page.on("pageerror", (e) => console.error(`${name}: ${e.message}`));
  // The demo answers every socket with presence; Screen's gets the sample
  // desktop instead, in the JPEG format the companion uses as its fallback.
  if (screen)
    await page.addInitScript((b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      class ScreenSocket {
        readyState = 0;
        binaryType = "arraybuffer";
        onopen = null;
        onmessage = null;
        onclose = null;
        onerror = null;
        id = 0;
        timer = 0;
        constructor() {
          setTimeout(() => {
            this.readyState = 1;
            this.onopen?.({});
          }, 30);
        }
        send(data) {
          let m;
          try {
            m = JSON.parse(data);
          } catch {
            return;
          }
          if (m.type !== "auth") return;
          this.onmessage?.({
            data: JSON.stringify({
              type: "ready",
              format: "jpeg",
              fps: 60,
              display: m.display ?? 1,
            }),
          });
          const frame = () => {
            if (this.readyState !== 1) return;
            const packet = new ArrayBuffer(4 + bytes.length);
            new DataView(packet).setUint32(0, ++this.id);
            new Uint8Array(packet, 4).set(bytes);
            this.onmessage?.({ data: packet });
          };
          frame();
          this.timer = setInterval(frame, 300);
        }
        close() {
          this.readyState = 3;
          clearInterval(this.timer);
          this.onclose?.({ code: 1000 });
        }
      }
      const Native = window.WebSocket;
      let demo;
      function Socket(url, protocols) {
        if (/\/ws\/screen$/.test(new URL(String(url), location.href).pathname))
          return new ScreenSocket();
        return new (demo || Native)(url, protocols);
      }
      Object.assign(Socket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
      Object.defineProperty(window, "WebSocket", {
        configurable: true,
        get: () => (demo ? Socket : Native),
        set: (v) => {
          demo = v;
        },
      });
    }, desktop);
  await page.goto(`${base}${url}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(2000);
  for (const step of steps) {
    await page
      .getByRole("button", { name: step, exact: true })
      .filter({ visible: true })
      .first()
      .click();
    await page.waitForTimeout(1500);
  }
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  await page.close();
  console.log(`${name}.png`);
}

await scene("home", "/");
await scene("screen", "/", ["Screen"], { screen: true });
await scene("invite", "/", ["Invite an agent or someone"]);
await scene("approve", "/scripts/demo/agent-access.html?view=connect-full");
await scene("chat", "/", ["Chat", "Build a better workspace, Codex"]);
await scene("files", "/scripts/demo/files.html", [
  "More workspace options",
  "Files",
]);
await browser.close();
