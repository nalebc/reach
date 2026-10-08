// What Claude Code asks in a terminal (its permission menu), shown on the
// phone exactly as the terminal shows it and answered as if typed there:
// Reach finds the terminal tab the chat runs in (by its tty, through Reach's
// Mac terminals: desktop-terminals.mjs), reads the menu still on its screen
// ("Do you want to proceed?" and its numbered choices), and on the person's
// tap only types that choice's number into that tab.
const QUESTION = /^\s*(Do you want|Would you like)\b.*\?\s*$/;
const OPTION = /^\s*(?:[❯›>]\s*)?(\d{1,2})\.\s+(.*\S)\s*$/;
// What a menu shows under its choices (how to cancel or amend).
const HINT = /^\s*(Esc|Tab|Enter|Press|ctrl|⏎)\b/i;
const squeezed = (text) => String(text).replace(/\s+/g, "").toLowerCase();
const ttyName = (tty) => String(tty || "").replace(/^\/dev\//, "");

// The menu on the screen now: its question, its choices (as printed, the
// number typed for each), and the lines above it (what it asks about). Null
// when the newest question has been answered (more came after it).
export function parseTerminalMenu(text) {
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  for (let q = lines.length - 1; q >= 0; q--) {
    if (!QUESTION.test(lines[q])) continue;
    const options = [];
    let i = q + 1;
    for (; i < lines.length && i <= q + 40; i++) {
      const line = lines[i];
      const m = OPTION.exec(line);
      if (m) {
        options.push({ key: m[1], label: m[2] });
        continue;
      }
      if (!line.trim()) {
        if (options.length) break;
        continue;
      }
      // A long choice wrapped onto the next line.
      if (options.length && /^\s{2,}\S/.test(line) && !HINT.test(line)) {
        options.at(-1).label += ` ${line.trim()}`;
        continue;
      }
      break;
    }
    if (options.length < 2) return null;
    // Still on screen: nothing after it but hints and blank lines.
    if (lines.slice(i).some((line) => line.trim() && !HINT.test(line))) return null;
    return {
      question: lines[q].trim(),
      options: options.map(({ key, label }) => ({ key, label: label.replace(/\s+/g, " ") })),
      about: lines.slice(Math.max(0, q - 40), q).join("\n"),
    };
  }
  return null;
}

export function createTerminalCards({ terminals, wait = (ms) => new Promise((r) => setTimeout(r, ms)), confirmMs = 6000 }) {
  const allow = () => {};
  // The tab whose tty is the chat's (Apple Terminal or iTerm2).
  const tab = async (tty, authorize = allow) => {
    authorize();
    const { sessions } = await terminals.list(authorize);
    authorize();
    const found = sessions.find((s) => ttyName(s.tty) && ttyName(s.tty) === ttyName(tty));
    if (!found) throw Object.assign(new Error("Reach can't find the terminal this chat runs in. Answer it there."), { status: 409 });
    return found.id;
  };
  const menuIn = async (id, expect, authorize = allow) => {
    authorize();
    const { text } = await terminals.action(id, "read", {}, authorize);
    authorize();
    const menu = parseTerminalMenu(text);
    // Only the menu that asks about this request.
    if (!menu || !expect.every((e) => squeezed(menu.about).includes(squeezed(e)))) return null;
    return menu;
  };
  return {
    // The card as the terminal shows it: { found, texts, buttons }.
    async read(tty, expect, guard = () => {}) {
      const authorize = () => { allow(); guard(); };
      const menu = await menuIn(await tab(tty, authorize), expect, authorize);
      if (!menu) return { found: false };
      return { found: true, texts: [menu.question], buttons: menu.options.map((o) => ({ label: o.label, menu: false })) };
    },
    // Types the number of the choice with exactly that label, then waits for
    // the menu to go.
    async press(tty, label, expect, guard = () => {}) {
      const authorize = () => { allow(); guard(); };
      let id, choice;
      try {
        id = await tab(tty, authorize);
        const menu = await menuIn(id, expect, authorize);
        if (!menu) throw Object.assign(new Error("This request was already answered."), { status: 409 });
        choice = menu.options.filter((o) => o.label === label);
        if (choice.length !== 1) throw Object.assign(new Error(`The terminal no longer offers "${label}".`), { status: 409 });
        authorize();
      } catch (error) { throw Object.assign(error, { notDispatched: true }); }
      // The terminal queue checks ownership again at actual dispatch. Its
      // existing authority checks remain independent of foreground changes.
      await terminals.action(id, "send", { text: choice[0].key }, allow, { beforeDispatch: guard });
      for (const until = Date.now() + confirmMs; Date.now() < until; await wait(250)) if (!(await menuIn(id, expect))) return { pressed: label };
      throw Object.assign(new Error("The terminal didn't take the answer. Answer it there."), { status: 409 });
    },
  };
}
