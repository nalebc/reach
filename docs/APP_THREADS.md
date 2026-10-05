# Apps on your phone

Open a Mac app from **Apps** on your phone and it runs on the Mac, shaped like your phone, full screen on the phone. Chrome shows websites' mobile layouts; Notes, Messages and others work as they do on the Mac. Several apps can be open at once, each in its own thread, while the Mac's own screen stays as it was. **Screen** still shows and controls the whole Mac.

## Use it

1. Turn on screen viewing in Reach, and allow **Screen Recording** and **Accessibility** for the app running Reach (Terminal, or Reach's helpers in background mode) in System Settings → Privacy & Security.
2. On the phone, open **Apps** and tap an app. The first open takes a few seconds.
3. Use it like a phone app. The app gets the whole screen; Reach keeps only a small handle at the bottom.
   - **Tap** clicks. Two quick taps double-click. A tap during a fling only stops it, as on iPhone.
   - **Swipe** scrolls: the picture follows your finger at once, and a flick keeps scrolling with iPhone-style momentum.
   - **Touch and hold** right-clicks; hold, then move, to drag.
   - **Pinch** zooms the phone's view (useful for apps with a wide minimum size).
   - Tap a text field and the phone's keyboard opens in the same tap (the Mac tells the phone where its text fields are). Enter, Tab, Esc, arrows and Delete sit above it.
4. **The handle:** tap it or swipe it up for the controls: **‹** back to Reach (the app keeps running), other open apps to switch to, the keyboard, **give back to the Mac**, and **Quit**. Swipe the handle sideways to switch apps.
5. **Quit** closes the app on the Mac like ⌘Q, so it can still ask to save; answer it right there on the phone. If the app also has windows on the Mac's own screen (your other Chrome windows, say), Reach asks first.
6. **On your phone**, at the top of Apps, shows open apps with the last screen you saw. Swipe a card up to quit that app. Touch and hold an app's icon to open it on the Mac only, as before.

## How it works

Each app gets a hidden display that only the phone sees, made with macOS's virtual display API. Its window moves there and is sized to the phone's shape; Reach streams just that window at full Retina resolution, up to 60 fps, lowering frame rate and bitrate by itself on a slow connection. Taps go to that display, so nothing on the Mac's real screen is covered or moved.

- Browsers, Finder and Terminal open a fresh window for the phone. Other apps lend their main window, which returns to exactly where it was when you're done.
- A window keeps the phone's proportions at the app's own minimum width (Chrome 500 points, Notes about 710), so wide apps appear slightly smaller; pinch to zoom.
- Hidden displays are at least 800 points wide: below that, macOS starts them at 1x instead of Retina. The window sits phone-sized inside and only it is streamed.
- Scrolling is shown on the phone first and handed over to the Mac's video over about one round trip, so it tracks your finger even on a slower connection.
- Turning the phone reshapes the window; the hidden display is sized for both orientations, so the Mac's displays aren't reconfigured.
- The Mac's menu bar shows **Reach · Chrome** (or how many apps are on the phone), with **Return all to this Mac**.
- If Reach stops, the hidden displays go with it and macOS returns their windows to the main screen. After a restart, apps you had open show as paused; one tap reopens them.

## Limits

- **One pointer, one keyboard focus.** Using an app from the phone moves the Mac's pointer to its hidden display and brings that app to the front. Someone typing on the Mac at the same moment types into it.
- The virtual display API is undocumented. Reach checks for it at runtime; it worked on macOS 26 (Apple Silicon) when this was written.
- Some system dialogs (permission prompts, some file pickers) can open on the Mac's main screen; reach them through **Screen**.
- No sound yet. Mac only for now; Windows will follow by sizing the window on the real screen.
- Stage Manager has not been tested.

## Verify

`npm test` covers the server (`test/app-threads.test.mjs`, with a fake helper; on a Mac it also builds the real helper and checks its probe) and the phone view (`test/app-thread-ui.test.mjs`: taps, scrolling with momentum, hold, drag, pinch, typing, rotation, switching). For a hands-on check with real apps: open Chrome on the phone, type in the address bar, rotate, switch to a second app, give both back, and confirm their windows return; then restart Reach mid-session and check the windows come back and the threads show paused.
