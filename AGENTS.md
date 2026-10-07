# Working on Reach (coding agents)

## Running Reach

One Reach runs per computer. Use the CLI for every start, stop and restart:

- `./reach status`: where Reach runs (a Terminal window, the background, or the service), since when, and its link.
- `./reach restart`: stop it and start it again, in a Terminal window. It asks before closing Reach's terminals.
- `./reach stop`: stop every Reach on this computer.

Never start Reach any other way: no `nohup`, no `&`, no background shell, no `node scripts/bootstrap.mjs`, no `npm run go`. Started without a Terminal window, Reach has no Screen Recording or Accessibility permission (no live screen, no control) and can't approve new phones.

If `./reach` says Reach is already running, don't start another copy. Tell the user where it runs and offer `./reach restart`.

Interface changes (`src/`, `public/`, `index.html`) need no restart: Reach rebuilds them and open phones reload on their own. Only server changes need one. When you run `./reach restart`, it asks the user on their phone (Needs you) and returns; Reach restarts when they tap Restart. Don't run it again while it's waiting.

Restarting ends Reach's terminals and live streams. Run `./reach status` first, and ask the user before restarting while they use it. Never pass `--yes` to `stop` or `restart` (it closes Reach's terminals without asking) unless the user said so.
