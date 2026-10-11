import readline from "node:readline";

export const promptLabel = (value) =>
  String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, "");
const cancelled = () => new Error("Cancelled. No pending choice was applied.");

// Shared menu UI. Load the library only when needed: first-run configure can run
// before npm dependencies exist, in which case the numbered menu still works.
export function terminalPrompts({
  input = process.stdin,
  output = process.stdout,
  env = process.env,
  load = () => import("prompts"),
} = {}) {
  let library;
  const ensureInteractive = () => {
    if (!input.isTTY)
      throw Error(
        "Run this command in an interactive terminal. No option was selected.",
      );
  };
  const line = (message) =>
    new Promise((resolve, reject) => {
      ensureInteractive();
      const rl = readline.createInterface({ input, output, terminal: false });
      const finish = (error, value) => {
        rl.removeAllListeners("close");
        rl.removeAllListeners("SIGINT");
        rl.removeAllListeners("line");
        rl.close();
        error ? reject(error) : resolve(value);
      };
      rl.once("line", (value) => finish(null, value));
      rl.once("SIGINT", () => finish(cancelled()));
      rl.once("close", () => finish(cancelled()));
      output.write(message);
    });
  const ask = async (message) => line(`${promptLabel(message)} `);
  const select = async ({ message, choices, initial }) => {
    ensureInteractive();
    if (!choices.length) throw Error("This menu has no choices.");
    const selected = Math.max(
      0,
      choices.findIndex((c) => c.value === initial),
    );
    const items = choices.map((c) => ({
      title: `${promptLabel(c.label)}${c.recommended ? " (Recommended)" : ""}`,
      description: c.description ? promptLabel(c.description) : undefined,
      value: c.value,
    }));
    if (output.isTTY && input.setRawMode && env.TERM !== "dumb") {
      // Not installed yet is asked again at the next menu: the first run
      // installs it while setup's menus are on screen.
      let loaded = library;
      if (loaded === undefined) {
        try {
          loaded = library = (await load()).default;
        } catch (error) {
          if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
          loaded = null;
        }
      }
      if (loaded) {
        let active;
        const end = () => active?.abort();
        input.once("end", end);
        try {
          const result = await loaded(
            {
              type: "select",
              name: "choice",
              message: promptLabel(message),
              choices: items,
              initial: selected,
              hint: "↑/↓ to move · Enter to select · Esc to cancel",
              stdin: input,
              stdout: output,
              onRender() {
                active = this;
              },
            },
            {
              onCancel() {
                throw cancelled();
              },
            },
          );
          if (!choices.some((c) => c.value === result.choice))
            throw cancelled();
          return result.choice;
        } finally {
          input.removeListener("end", end);
        }
      }
    }
    output.write(`\n${promptLabel(message)}\n`);
    items.forEach((item, i) =>
      output.write(
        `  ${i + 1}. ${item.title}${item.description ? ` — ${item.description}` : ""}\n`,
      ),
    );
    while (true) {
      const answer = (
        await line(
          `Choose 1–${items.length} [${selected + 1}], or q to cancel: `,
        )
      ).trim();
      if (/^(q|quit|cancel)$/i.test(answer)) throw cancelled();
      const index =
        answer === ""
          ? selected
          : /^\d+$/.test(answer)
            ? Number(answer) - 1
            : -1;
      if (items[index]) return items[index].value;
      output.write("Choose one of the listed numbers.\n");
    }
  };
  return { ask, select };
}
