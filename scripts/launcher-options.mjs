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
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (
      i === 0 &&
      [
        "install",
        "uninstall",
        "status",
        "pair",
        "configure",
        "approve",
        "invites",
        "update",
        "import",
      ].includes(arg)
    )
      options.command = arg;
    // `reach import <folder>`: the Reach folder whose pairings to bring over.
    else if (options.command === "import" && i === 1 && !arg.startsWith("--"))
      options.importFrom = path.resolve(arg);
    else if (arg === "--version" || arg === "-v") options.version = true;
    else if (arg === "--local") options.local = true;
    else if (arg === "--service") options.service = true;
    else if (arg === "--stay-awake") options.stayAwake = true;
    else if (arg === "--stay-awake-always") options.stayAwake = "always";
    else if (arg === "--no-stay-awake") options.stayAwake = false;
    else if (arg === "--background") options.background = true;
    else if (arg === "--stop-background") options.stopBackground = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
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
  if (options.command === "import" && !options.importFrom && !options.help)
    throw Error("Name the Reach folder to import from: reach import <folder>.");
  if (
    options.command &&
    options.command !== "install" &&
    args.length > (options.command === "import" ? 2 : 1) &&
    !options.help
  )
    throw Error(`reach ${options.command} does not accept setup options.`);
  return options;
}
