// content.js
// Runs on music.youtube.com. Accepts a small fixed set of commands and
// nothing else. Messages can never carry code or selectors.

const VOLUME_STEP = 10;
let searching = false; // one search at a time

const ALLOWED_COMMANDS = {
  play: () => YTMAdapter.play(),
  pause: () => YTMAdapter.pause(),
  toggle: () => YTMAdapter.toggle(),
  next: () => YTMAdapter.next(),
  previous: () => YTMAdapter.previous(),
  volumeUp: () => YTMAdapter.setVolume(YTMAdapter.getVolume() + VOLUME_STEP),
  volumeDown: () => YTMAdapter.setVolume(YTMAdapter.getVolume() - VOLUME_STEP),
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only accept messages from this extension itself
  if (sender.id !== chrome.runtime.id) return;
  if (!msg || typeof msg.type !== "string") return;

  if (msg.type === "GET_STATE") {
    sendResponse({ ok: true, state: YTMAdapter.getState() });
    return;
  }

  if (msg.type === "SEARCH") {
    // A short line of text, nothing else
    const valid =
      typeof msg.q === "string" && msg.q.length >= 1 && msg.q.length <= 80 && !/[\u0000-\u001f\u007f]/.test(msg.q);
    if (!valid) {
      sendResponse({ ok: false, err: "bad" });
      return;
    }
    if (searching) {
      sendResponse({ ok: false, err: "busy" });
      return;
    }
    searching = true;
    YTMAdapter.search(msg.q)
      .then((result) => sendResponse(result))
      .catch(() => sendResponse({ ok: false, err: "nosearch" }))
      .finally(() => {
        searching = false;
      });
    return true; // the answer comes after the page has loaded the results
  }

  if (msg.type === "PLAY_RESULT") {
    const valid =
      Number.isInteger(msg.index) && msg.index >= 0 && msg.index < 20 &&
      typeof msg.title === "string" && msg.title.length <= 60;
    const ok = valid && YTMAdapter.playResult(msg.index, msg.title);
    setTimeout(() => sendResponse({ ok: ok, state: YTMAdapter.getState() }), 600);
    return true;
  }

  if (msg.type === "GET_QUEUE") {
    sendResponse({ ok: true, queue: YTMAdapter.getQueue() });
    return;
  }

    if (msg.type === "COMMAND") {
    if (msg.command === "seek") {
      // A whole number of seconds (up to 24 hours), nothing else
      if (!Number.isInteger(msg.pos) || msg.pos < 0 || msg.pos > 86400) {
        sendResponse({ ok: false, error: "bad position" });
        return;
      }
      YTMAdapter.seekTo(msg.pos);
      setTimeout(() => sendResponse({ ok: true, state: YTMAdapter.getState() }), 300);
      return true;
    }
    if (msg.command === "volume") {
      // A whole number from 0 to 100, nothing else
      if (!Number.isInteger(msg.level) || msg.level < 0 || msg.level > 100) {
        sendResponse({ ok: false, error: "bad volume" });
        return;
      }
      YTMAdapter.setVolume(msg.level);
      sendResponse({ ok: true });
      return;
    }
    if (msg.command === "jump") {
      // The only command with parameters: a whole number and a short title, nothing else
      const valid =
        Number.isInteger(msg.index) && msg.index >= 0 && msg.index < 500 &&
        typeof msg.title === "string" && msg.title.length <= 60;
      const ok = valid && YTMAdapter.jumpTo(msg.index, msg.title);
      setTimeout(() => sendResponse({ ok: ok, state: YTMAdapter.getState() }), 600);
      return true;
    }
    const known = Object.prototype.hasOwnProperty.call(ALLOWED_COMMANDS, msg.command);
    if (!known) {
      sendResponse({ ok: false, error: "unknown command" });
      return;
    }
    ALLOWED_COMMANDS[msg.command]();
    // Give the page a moment to update, then report the new state
    setTimeout(() => {
      sendResponse({ ok: true, state: YTMAdapter.getState() });
    }, 300);
    return true; // keep the channel open for the delayed response
  }
});
