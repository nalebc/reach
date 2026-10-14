# Working on Reach (coding agents)

## Platform support

Build changes for every platform Reach supports. Screen control must cover macOS and Windows hosts and touch clients on iPhone, iPad, and Android. Prefer shared gesture and coordinate logic. When native behavior differs, cover both paths and put the relevant shared and Windows-specific regression tests in Windows CI. Clearly distinguish mocked checks from validation run on the actual operating system.

## Running Reach

One Reach runs per computer. Use the CLI for every start, stop and restart:

- `./reach status`: where Reach runs (a Terminal window, the background, or the service), since when, and its link.
- `./reach restart`: stop it and start it again, in a Terminal window. It asks before closing Reach's terminals.
- `./reach stop`: stop every Reach on this computer.

Never start Reach any other way: no `nohup`, no `&`, no background shell, no `node scripts/bootstrap.mjs`, no `npm run go`. Started without a Terminal window, Reach has no Screen Recording or Accessibility permission (no live screen, no control) and can't approve new phones.

If `./reach` says Reach is already running, don't start another copy. Tell the user where it runs and offer `./reach restart`.

Interface changes (`src/`, `public/`, `index.html`) need no restart: Reach rebuilds them and open phones reload on their own. Only server changes need one. When you run `./reach restart`, it asks the user on their phone (Needs you) and returns; Reach restarts when they tap Restart. Don't run it again while it's waiting.

Restarting ends Reach's terminals and live streams. Run `./reach status` first, and ask the user before restarting while they use it. Never pass `--yes` to `stop` or `restart` (it closes Reach's terminals without asking) unless the user said so.

## Running tests

Run tests through npm so each test process carries the runaway guard (`test/helpers/runaway-guard.mjs`): `npm test` for everything, `npm run test:file -- test/x.test.mjs` for one or a few files. Never bare `node --test`. On Oct 9 failing assertions grew three test processes to 80 GB together and logged the Mac out; the guard keeps any single test under 2 GB.

Don't start a full `npm test` while another one is running on this Mac (check `ps -Ao args | grep "node.*--test"`); run only the files your change touches.
