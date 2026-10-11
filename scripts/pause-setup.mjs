import { command } from "./home.mjs";

// Ctrl+C while the guided setup waits (for Tailscale, its HTTPS switch, a
// sign-in, a menu): said, then Reach exits so its own exit handlers run (the
// launcher's lock goes), and the next ./reach picks up at the same step
// (docs/FIRST_RUN_MATRIX.md, H10). `before` stops what setup started (an
// install running meanwhile). Returns the function that stops listening.
export function pauseOnInterrupt({ before = () => {}, print = console.log, exit = (code) => process.exit(code), on = process } = {}) {
  const paused = () => {
    before();
    print(`\n  Paused. Run ${command} to continue your setup.`);
    exit(130);
  };
  on.once("SIGINT", paused);
  return () => on.removeListener("SIGINT", paused);
}
