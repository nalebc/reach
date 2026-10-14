import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { startComputer, phone, skip, word, windows, needsDesktop, macInUse, desktopTurn } from "../helpers/journey.mjs";

// Apps: the computer's apps listed on the phone with their own icons, and
// one opened on the computer from it (on a Mac with its screen on, a tap
// opens an app on the phone and touch and hold on the Mac; on a PC a tap
// opens it there). Proven from the computer's side too: the app runs. A Mac
// gets Chess, which nobody is using (never one already open); a PC Notepad.
const app = windows ? { name: "Notepad", image: "notepad.exe" } : { name: "Chess", image: "Chess" };
const running = () => {
  try {
    if (windows) return /notepad\.exe/i.test(execFileSync("tasklist.exe", ["/FI", `IMAGENAME eq ${app.image}`, "/NH"], { encoding: "utf8", windowsHide: true }));
    execFileSync("/usr/bin/pgrep", ["-x", app.image]);
    return true;
  } catch {
    return false;
  }
};
const quit = () => {
  try {
    if (windows) execFileSync("taskkill.exe", ["/IM", app.image, "/F"], { windowsHide: true, stdio: "ignore" });
    else execFileSync("/usr/bin/pkill", ["-x", app.image]);
  } catch {}
};

test(
  `Apps: this ${word}'s apps are listed on the phone with their own icons, and one opens on the ${word} from it`,
  { skip: skip || needsDesktop || macInUse() || (running() && `${app.name} is already open on this ${word}`), timeout: 240000 },
  async (t) => {
    if (!(await desktopTurn(t))) return;
    const computer = await startComputer(t);
    const page = await phone(t, computer);
    await page.skipIntro();
    // Apps opens from what points to it (an app an agent handed you, a
    // notification): its link.
    await page.open("/?page=apps");
    await page.see(() => document.querySelector(".apps-page h1, .apps-page")?.innerText?.includes("Apps"), "the Apps page", 30000);
    const count = await page.see(() => document.querySelectorAll("button.app-tile").length, "the computer's apps", 60000);
    assert.ok(count >= 5, `apps listed: ${count}`);
    // The first ones drawn with their own icons, as the computer draws them.
    await page.see(
      () => {
        const tiles = [...document.querySelectorAll("button.app-tile")].slice(0, 6);
        return tiles.length && tiles.filter((b) => b.querySelector(".app-logo.has-icon img")).length >= Math.min(4, tiles.length);
      },
      "the apps' own icons",
      60000,
    );
    await page.shot("apps");
    await page.tap(`input[aria-label="Find an app"]`, "Find an app");
    await page.type(app.name);
    const tile = { selector: "button.app-tile", text: new RegExp(`^${app.name}$`) };
    const title = await page.see({ js: `[...document.querySelectorAll("button.app-tile")].find((b) => b.querySelector(".app-tile-name")?.innerText.trim() === ${JSON.stringify(app.name)})?.title` }, `${app.name} found`, 30000);
    t.after(quit);
    if (/Touch and hold to open it on/.test(title)) {
      // A Mac with its screen on: touch and hold opens it on the Mac.
      const at = await page.see({ js: `(() => { const b = [...document.querySelectorAll("button.app-tile")].find((b) => b.querySelector(".app-tile-name")?.innerText.trim() === ${JSON.stringify(app.name)}); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()` }, app.name);
      await page.hold(at.x, at.y, 800);
    } else await page.tap(tile, app.name);
    await page.see(`${app.name} is open on`, `"${app.name} is open on …"`, 30000);
    for (const end = Date.now() + 30000; !running() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 300));
    assert.equal(running(), true, `${app.name} runs on the ${word}`);
    await page.shot("opened");
  },
);
