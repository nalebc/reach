# Screen action checks

Automated tests (`test/screen-actions.test.mjs`) verify that every Screen action
sends the intended keys, that its shortcut text is generated from those keys,
and that the server and each native helper accept them. They cannot verify what
the operating system does with the keys. Run this checklist on real hardware
after changing `src/screen-action-catalog.ts` or a native input helper, and
record the date, OS version and result.

Setup: open Screen on the phone, enable **Control**, and open **Screen options →
Shortcuts**. For tab actions, focus a browser window with at least three tabs.
For desktop actions, create at least two desktops (Mac: Mission Control →
**+**; Windows: Task View → **New desktop**).

| Action | Mac: expected result | Windows: expected result |
| --- | --- | --- |
| Previous tab / Next tab | Browser moves one tab left / right | Same |
| New tab | Browser opens a new tab | Same |
| Reopen tab | Last closed tab returns | Same |
| Close tab / window | Current tab closes | Same |
| Switch app | Previous app comes to the front (⌘ Tab) | Previous window comes to the front (Alt Tab) |
| All windows | Mission Control opens (Ctrl ↑) | Task View opens (Win Tab) |
| Previous / Next desktop | Switches desktop (Ctrl ← / →) | Switches desktop (Win Ctrl ← / →) |
| Find | Find bar opens | Same |
| Undo | Last edit in a text field is undone | Same |
| Escape | Closes a menu or dialog | Same |
| Keyboard → ← ↑ ↓ (no modifiers) | Caret moves in a text field; arrows never type digits | Same, with Num Lock **on** |
| Keyboard → Home / End / Page Up / Page Down | Caret or page moves as on a physical keyboard | Same, with Num Lock **on** |
| Keyboard → F1–F12 | The app's function-key action, not brightness/volume | The app's function-key action |

Notes

- macOS: Mission Control and desktop shortcuts must be enabled in System
  Settings → Keyboard → Keyboard Shortcuts → Mission Control. If an action does
  nothing, check that first.
- macOS rebuilds the input helper whenever its source changes. The first
  connection afterwards is slower, and macOS may ask again for Accessibility.
- An action that cannot be confirmed by Reach is reported as **sent**, not done.
