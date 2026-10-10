import path from "node:path";

export function parseOptions(args) {
  const options = {
    local: false,
    folders: [],
    port: 0,
    httpsPort: 8443,
    help: false,
    stayAwake: "always",
  };
  // `--yes restart` works as `restart --yes`.
  const first = ["--yes", "-y"].includes(args[0]) ? 1 : 0;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (
      i === first &&
      [
        "install",
        "uninstall",
        "status",
        "pair",
        "configure",
        "setup",
        "approve",
        "invites",
        "link",
        "update",
        "import",
        "stop",
        "restart",
        "cli",
      ].includes(arg)
    )
      options.command = arg;
    // `reach import <folder>`: the Reach folder whose pairings to bring over.
    else if (options.command === "import" && i === first + 1 && !arg.startsWith("--"))
      options.importFrom = path.resolve(arg);
    // `reach link <name>`: link another Reach computer on your tailnet.
    else if (options.command === "link" && i === first + 1 && !arg.startsWith("--"))
      options.linkName = arg;
    // `reach setup <section>`: redo one part of setup (account, invites, …).
    else if (options.command === "setup" && i === first + 1 && !arg.startsWith("--"))
      options.setupSection = arg;
    else if (arg === "--version" || arg === "-v") options.version = true;
    else if (arg === "--local") options.local = true;
    else if (arg === "--service") options.service = true;
    else if (arg === "--stay-awake") options.stayAwake = true;
    else if (arg === "--stay-awake-always") options.stayAwake = "always";
    else if (arg === "--no-stay-awake") options.stayAwake = false;
    else if (arg === "--background") options.background = true;
    else if (arg === "--stop-background") options.stopBackground = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    // `reach stop|restart --yes`: close Reach's terminals without asking.
    else if ((arg === "--yes" || arg === "-y") && (["stop", "restart"].includes(options.command) || i < first)) options.yes = true;
    else if (arg === "--agent-policy") {
      if (!args[i + 1] || args[i + 1].startsWith("--"))
        throw Error("--agent-policy needs a JSON file.");
      options.agentPolicyFile = path.resolve(args[++i]);
    } else if (arg === "--folder") {
      if (!args[i + 1] || args[i + 1].startsWith("--"))
        throw Error("--folder needs a directory.");
      options.folders.push(path.resolve(args[++i]));
    } else if (arg === "--port" || arg === "--https-port") {
      const value = args[++i];
      if (
        !/^\d+$/.test(value || "") ||
        Number(value) < 1 ||
        Number(value) > 65535
      )
        throw Error(`${arg} must be between 1 and 65535.`);
      if (arg === "--port") options.port = Number(value);
      else options.httpsPort = Number(value);
    } else throw Error(`Unknown option: ${arg}. Run with --help for options.`);
  }
  if (options.background && options.stopBackground)
    throw Error("Choose --background or --stop-background, not both.");
  if (
    (options.command &&
      (options.background || options.stopBackground || options.service)) ||
    (options.service && (options.background || options.stopBackground))
  )
    throw Error("Choose one Reach command.");
  if (options.yes && !["stop", "restart"].includes(options.command)) throw Error("Unknown option: --yes");
  if (options.command === "import" && !options.importFrom && !options.help)
    throw Error("Name the Reach folder to import from: reach import <folder>.");
  if (
    options.command &&
    options.command !== "install" &&
    args.length - (options.yes ? 1 : 0) >
      (["import", "link", "setup"].includes(options.command) ? 2 : 1) &&
    !options.help
  )
    throw Error(`reach ${options.command} does not accept setup options.`);
  return options;
}
