// The iPhone's own fullscreen for the live picture, as a video plays it
// (Oct 27: "not a real fullscreen like YouTube; I want the phone's built-in
// fullscreen"). iPhone Safari gives a page element no fullscreen of its own;
// a video gets the system's: the whole screen, the status bar gone, turning
// with the phone. The picture is drawn into a canvas, so the canvas plays
// into a video that the system shows. It's for watching: iOS's player has
// the touches there, and Done comes back to Reach's view, which controls.
// Reach's own fullscreen, which controls, is the phone turned on its side.
type FullscreenVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void; webkitDisplayingFullscreen?: boolean };

// An iPhone or iPad whose browser shows a video in the system's fullscreen
// and can play a canvas into a video.
export function systemVideoFullscreen(): boolean {
  if (typeof document === "undefined") return false;
  const apple = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  return apple &&
    typeof (HTMLVideoElement.prototype as FullscreenVideo).webkitEnterFullscreen === "function" &&
    typeof HTMLCanvasElement.prototype.captureStream === "function";
}

export type Watch = {
  // From a tap: into the system's fullscreen. False when the picture isn't
  // ready to play yet (nothing drawn in it so far).
  enter: () => boolean;
  stop: () => void;
};

// Ready ahead of the tap: iOS enters a video's fullscreen only from a tap,
// and only once the video knows its size, which takes the picture's next
// frame. Paused until used, so it costs nothing while it waits.
export function prepareWatch(canvas: HTMLCanvasElement, events: { entered?: () => void; left?: () => void } = {}): Watch {
  const video = document.createElement("video") as FullscreenVideo;
  video.className = "screen-watch-video";
  video.muted = true;
  video.playsInline = true;
  video.setAttribute("playsinline", "");
  video.setAttribute("aria-hidden", "true");
  // In the page (iOS plays only a video in it), out of sight and out of the way.
  video.style.cssText = "position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none;z-index:-1";
  const stream = canvas.captureStream();
  video.srcObject = stream;
  document.body.append(video);
  const began = () => events.entered?.();
  const ended = () => {
    video.pause();
    events.left?.();
  };
  video.addEventListener("webkitbeginfullscreen", began);
  video.addEventListener("webkitendfullscreen", ended);
  return {
    enter: () => {
      if (video.readyState < HTMLMediaElement.HAVE_METADATA || !video.webkitEnterFullscreen) return false;
      void video.play().catch(() => {});
      try {
        video.webkitEnterFullscreen();
        return true;
      } catch {
        return false;
      }
    },
    stop: () => {
      video.removeEventListener("webkitbeginfullscreen", began);
      video.removeEventListener("webkitendfullscreen", ended);
      video.pause();
      for (const track of stream.getTracks()) track.stop();
      video.srcObject = null;
      video.remove();
    },
  };
}
