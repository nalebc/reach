import assert from "node:assert/strict";
import { startIosLaunchLogs } from "./ios-diagnostics.mjs";

// Only the disposable simulator's first app launch and its one recovery
// reboot. sim supplies the smoke test's bounded commands and total budget.
export async function launchIosSmokeApp({ sim, device, bundle, appPage, pageSeen, reached, startLogs = startIosLaunchLogs, observeLogs }) {
  // openurl can exit successfully at an "Open in Reach?" confirmation on the
  // home screen. Every attempt must launch the installed app directly.
  let logs = startLogs({ device, bundle });
  try { return await sim("launch", attempt =>
    ["launch", ...(attempt > 1 ? ["--terminate-running-process"] : []), device, bundle], {
    limit: 75000, attempts: 3, progress: appPage,
    beforeRetry: async attempt => {
      // Reboot only our disposable device once if the app has not requested
      // its unique page. Installed app/data and the test CA remain intact.
      if (attempt === 2 && !pageSeen()) {
        await sim("stalled launch shutdown", ["shutdown", device], { limit: 30000 });
        await sim("stalled launch boot", ["boot", device], { limit: 30000 });
        await sim("stalled launch bootstatus", ["bootstatus", device, "-b"], { limit: 120000 });
        const services = (await sim("stalled launch readiness", ["spawn", device, "launchctl", "list"], { limit: 30000, attempts: 2 })).stdout;
        assert.match(services, /^\d+\s+\S+\s+com\.apple\.SpringBoard$/m, "our rebooted simulator runs SpringBoard");
        reached("isolated simulator rebooted after stalled launch");
      }
      // Reboot ends the first stream. Observe each existing retry while
      // retaining bounded evidence from its preceding failed attempt.
      logs.stop({ retain: true });
      logs = startLogs({ device, bundle });
    },
  }); }
  catch (error) { logs.stop({ retain: true }); throw error; }
  finally {
    logs.stop();
    try { observeLogs?.(logs.snapshot?.()); } catch { /* An observer cannot replace the launch outcome. */ }
  }
}
