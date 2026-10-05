# Remote desktop

Reach's Screen page supports display selection, live H.264 video, trackpad/direct touch, dragging, pinch zoom/pan, the captured system cursor, automatic text-field detection, keyboard modifiers, explicit text clipboard transfers, and fullscreen. Capture and control run on the laptop; the phone uses a browser over the existing private Tailscale connection.

## Start and connect

1. Rebuild with `npm run build` after updating the checkout. Restart Reach using your usual launcher when active terminals/jobs can be interrupted; an existing server keeps its old backend code.
2. Connect the laptop and phone through Tailscale. Open the HTTPS link printed by Reach and pair normally. No Supabase credentials, public port, or new media service are needed.
3. Open **Screen → View screen**. On Mac, grant Screen Recording locally to the app running Reach or the capture helper when macOS requests it. Native helpers require Apple Command Line Tools and compile on first use; the first connection can take longer.
4. Video quality adjusts automatically. Open **Screen options** only if you need another display, a different touch mode, or connection details.
5. Press **Control** separately to enable input. Mac control also requires Accessibility permission for the app/helper. Windows must be signed in and unlocked. Reach does not bypass lock screens, permission prompts, UAC secure desktops, or protected content.

## Phone controls

| Control      | Gesture or action                                                                                                                                                                                                                   |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trackpad     | Slide one finger to move the cursor; tap to click. Two fingers scroll.                                                                                                                                                              |
| Direct touch | Tap the visible target. Choose right-click or double-click from Tap action.                                                                                                                                                         |
| Drag         | Long-press, then move and lift; or enable Drag before touching. Works for windows, selections, and files within the remote desktop.                                                                                                 |
| Zoom         | Pinch with two fingers, or use Ctrl/Command + the mouse wheel. The zoom stays anchored to the pinch position.                                                                                                                       |
| Pan          | Open Screen options and select Pan & zoom and drag the view. Direct touch also pans when moving without a held drag. Fit resets the view.                                                                                           |
| Keyboard     | Tap a detected text field or the keyboard button for the phone’s own keyboard. Text appears directly on the computer screen; there is no local typing box. Actions contains modifiers, navigation, tab shortcuts and function keys. |
| Clipboard    | Hold and drag over laptop text, then tap Copy selected text. Clipboard transfers in Screen options remains available for apps without accessible selection; paste through the phone’s native text menu.                             |
| Fullscreen   | Use Fullscreen; native browser fullscreen is preferred, with a viewport fallback. Controls remain available. Rotate the phone for a wider view.                                                                                     |

Tap a text field while Control is enabled. When the app exposes an editable field through macOS Accessibility or Windows UI Automation, a native text editor appears. Text, autocorrection, dictation, Backspace, and Enter go to that field immediately. Its buffer contains only text typed during this session, not the field’s pre-existing contents. Native selection, cut, copy, and paste work in that local buffer. Modifier buttons apply once to the next letter or number. More exposes navigation/function keys; Shift+Enter is available for chat newlines. Shortcut/navigation actions clear the local buffer so subsequent edits do not delete an unrelated suffix. The additional drawn cursor has been removed; click ripples and the cursor captured from the computer remain.

On iPhone, Safari may require one tap in the typing bar to open the keyboard after asynchronous detection. Custom controls that do not expose accessibility metadata may not be detected; use the keyboard button in that case. That button focuses the native editor synchronously during the tap and types at the laptop cursor without a focus guard when detection is unavailable. Automatic detection reads field metadata, not its contents. The separate Copy selected text action explicitly reads the current accessible selection (never a password field); it does not reuse an old laptop clipboard. If the phone denies clipboard writes, a selectable preview appears. Apps without accessible selections can use their own Copy shortcut and the manual clipboard transfers. Detected-field typing checks that the same field still has focus; switching focus stops the typing session. This is a best-effort check immediately before OS dispatch, not atomic isolation from other local input.

Clipboard access depends on browser permissions and a secure context. Use the HTTPS Tailscale link; if browser clipboard access is unavailable, manually copy/paste the preview text. Transfers are text-only, up to 16 KiB, and never automatic. Dragging files inside the remote desktop does not transfer them to the phone; use Reach Files for downloads/sharing.

Switching displays, pausing, hiding the app, or leaving the page releases control. Re-enable it when ready. Only one owner browser controls the laptop at a time. Temporary guests and screen-scoped agents can view when authorized but cannot control or access the clipboard.

## Video and performance

The default automatically targets up to 60 fps at 1600 px wide and 4 Mbps. Congestion reduces delivery rate toward 20 fps; Mac encoding also reduces bitrate toward 750 Kbps without reconnecting. Recovery raises quality gradually after healthy intervals. Slow viewers have individual bounded windows, so one slow viewer does not force faster viewers to degrade. These are targets, not guaranteed rates. Manual legacy API presets remain available for integrations; no bitrate/fps selector is shown in the main UI.

Mac capture uses ScreenCaptureKit NV12 and VideoToolbox H.264 with low-latency rate control and hardware acceleration when available. Windows H.264 uses an optional FFmpeg executable with the `libx264` encoder on PATH, or at the path configured by `REACH_FFMPEG`. Windows capture currently uses gdigrab and software encoding, so its CPU cost differs from Mac. No FFmpeg download is performed automatically.

The browser decodes H.264 with WebCodecs. Unsupported or failed decoding falls back to JPEG; **Use compatibility video** forces that mode. Windows without FFmpeg also uses JPEG. JPEG targets at most 20 fps and generally costs more bandwidth. Real video requires a browser with working H.264 WebCodecs support, so test the actual phone browser.

Delivery uses an authenticated WebSocket over HTTPS/Tailscale, not WebRTC/UDP. Tailscale's underlying transport does not turn screenshots into video. Identical viewers share capture/encoding. Bounded frame windows, bounded decoder queues, newest-frame JPEG decoding, keyframe recovery, and coalesced pointer moves prevent stale work from accumulating. Auto mode adjusts delivery pacing and, on Mac, encoder bitrate. Windows currently adjusts delivery pacing only. Network round trips, browser scheduling, thermal limits, display resolution, and Tailscale relay use can all reduce performance. A 60 fps setting is a target, not a guarantee.

## Shortcuts

Tap **Shortcuts** beside the screen, or the shortcut icon in the workspace header. Search installed apps or choose Chrome, Terminal, Open Codex, or New Codex session. The new-session action opens the documented [`codex://threads/new` deep link](https://learn.chatgpt.com/docs/reference/commands#deep-links) on the laptop, with an empty composer. It does not send a prompt or run agent work. Codex must be installed and registered to handle its URL scheme; having ChatGPT alone does not enable Codex shortcuts.

A Shortcuts section on the home screen shows suggested installed apps and saved favorites. Add & manage lets owners save, rename and remove custom shortcuts for an installed app action or an HTTP(S) website. Website links open in the laptop’s default browser. Shortcuts persist on that computer and are available to its paired owners. Uninstalled apps disappear from runnable shortcuts; unavailable saved definitions remain editable in the manager.

Actions use a server-generated catalog and saved, validated definitions. The run endpoint accepts only a shortcut ID. Shell commands, other URL schemes and app arguments are not supported. Shortcuts require an owner credential with app access; guests and scoped agents cannot use them. App discovery is cached for 30 seconds to avoid repeated Windows enumeration.

## Input latency

Video and input use separate connections, so a large video frame does not occupy the input socket's send queue. Native encoding and input run in separate processes. The input channel pipelines up to eight actions instead of waiting one network round trip per action; the host still dispatches them serially. Consecutive waiting moves coalesce while button/key order stays intact. Pending work is bounded and authorization is checked again at dispatch. Revocation discards queued input; it cannot undo an action already sent to the OS.

A deterministic 80 ms RTT simulation delivers 24 key actions in 240 ms using the eight-slot pipeline, compared with a calculated 1,920 ms sequential baseline. This measures protocol scheduling only, not real network, rendering, or physical phone latency. TCP still has head-of-line blocking within each connection; this is not a UDP/WebRTC implementation.

## Validation and remaining limits

Automated checks exercise protocol validation, coordinate/pinch geometry, drag and key dispatch, explicit clipboard access, owner/guest boundaries, lease expiry, revocation, and bounded video queues. The optional native test generates synthetic frames and sends them through the real Mac encoder without recording the desktop:

```sh
xcrun swiftc -parse-as-library -O scripts/native/screen-stream.swift -o /tmp/reach-screen-video-test
REACH_TEST_VIDEO_HELPER=/tmp/reach-screen-video-test npm test
```

For a real end-to-end check, test on the intended phone over cellular: move and resize a harmless window, select text, compare all four click corners before/after zoom, use modifier shortcuts, transfer a test clipboard string both ways, switch monitors, rotate/fullscreen, then hide the phone browser during a drag and verify the mouse releases. Revoke the phone or let a guest expire and verify access ends. Re-enable only the permissions you intend to use.

The browser interface has no audio, image clipboard sync, cross-device drag-and-drop, or unattended login/lock-screen access. Windows native behavior, Retina/mixed-DPI multi-monitor input, and physical iOS/Android keyboards, dictation, selection menus and multitouch need device validation. The streamed desktop is video, so native phone selection handles apply to the local typing/clipboard text, not arbitrary pixels in the stream. See [Security](SECURITY.md) for trust boundaries.

### Phone keyboard and fullscreen

Fullscreen fills the visible browser viewport on phones, including browsers that do not support native element fullscreen. On desktop, Reach tries native fullscreen and retains an in-page fallback if it is rejected or immediately withdrawn. Use the same button to exit; Escape also closes the in-page fullscreen.

On phones, typing opens a focused screen view with the native text composer directly above the operating system keyboard. The desktop resizes into the remaining space; a detected field is centered and enlarged using its tapped display coordinates. Closing the composer restores the previous view and page position. The draft grows with your text, and Command/Control/Option/Shift remain in the accessory row. Text is sent live; Enter sends the laptop's Enter key. Password targets remain masked. This does not turn arbitrary desktop controls into native mobile widgets or read the field's existing text.

Validation covers keyboard viewport resizing/panning, fullscreen fallback, closing the composer, and normalized input coordinates after reframing. Browser previews simulate keyboard geometry; real iPhone Safari and Android keyboard behavior still need device validation. Some phone browsers require tapping the visible composer or keyboard button before their keyboard opens.

On iPhone, Safari may require a tap on the keyboard button after Reach detects a
remote text field. The screen follows the visible viewport above the keyboard,
and detected fields are brought into view. Use × to dismiss the keyboard. Text
selection still happens on the remote computer; video pixels are not native iOS
text. Clipboard transfers remain explicit.
