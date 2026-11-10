// adapter.js
// The ONLY file that knows how the YouTube Music page is built.
// If YT Music changes its layout and something stops working, fix it here.

(function () {
  const SEL = {
    video: "video",
    playPause: "#play-pause-button",
    next: ".next-button",
    previous: ".previous-button",
    title: "ytmusic-player-bar .title",
    byline: "ytmusic-player-bar .byline",
    volumeSlider: "#volume-slider",
  };

  const $ = (selector) => document.querySelector(selector);
  const textOf = (selector) => (($(selector) || {}).textContent || "").trim();

  function clickButton(selector) {
    const el = $(selector);
    if (!el) return false;
    el.click();
    return true;
  }

  function isPlaying() {
    const video = $(SEL.video);
    return video ? !video.paused : false;
  }

  function getVolume() {
    const slider = $(SEL.volumeSlider);
    if (slider && slider.value !== undefined && slider.value !== null) {
      return Math.round(Number(slider.value));
    }
    const video = $(SEL.video);
    return video ? Math.round(video.volume * 100) : 0;
  }

  function setVolume(level) {
    const v = Math.max(0, Math.min(100, Math.round(level)));
    const slider = $(SEL.volumeSlider);
    if (slider) {
      slider.value = v;
      slider.dispatchEvent(new Event("change"));
    }
    const video = $(SEL.video);
    if (video) video.volume = v / 100;
  }

  // ---- Queue ----
  // YT Music keeps the queue in the page as <ytmusic-player-queue-item> rows.
  // Rows inside #counterpart-renderer are the hidden video/audio twin: skipped.
  const QUEUE_ITEM = "ytmusic-player-queue-item";
  const MAX_QUEUE_ITEMS = 500;

  function queueItems() {
    return Array.from(document.querySelectorAll(QUEUE_ITEM))
      .filter((el) => !el.closest("#counterpart-renderer"))
      .slice(0, MAX_QUEUE_ITEMS);
  }

  function itemText(el, selector) {
    const n = el.querySelector(selector);
    return n ? (n.textContent || "").replace(/\s+/g, " ").trim() : "";
  }

  function getQueue() {
    const els = queueItems();
    const items = els.map((el) => ({
      title: itemText(el, ".song-title"),
      artist: itemText(el, ".byline").split("•")[0].trim(),
      duration: itemText(el, ".duration"),
    }));
    let cur = els.findIndex((el) => el.hasAttribute("selected"));
    if (cur === -1) {
      // Fall back to matching the song shown in the player bar
      const now = getState().title;
      cur = now ? items.findIndex((it) => it.title === now) : -1;
    }
    return { cur: cur, items: items };
  }

  // Plays the row at `index`, but only if it still has the title the phone saw
  // (the queue may have changed since the phone drew it).
  function jumpTo(index, title) {
    const el = queueItems()[index];
    if (!el) return false;
    if (itemText(el, ".song-title").slice(0, title.length) !== title) return false;
    const target = el.querySelector("ytmusic-play-button-renderer") || el;
    target.click();
    return true;
  }

  function seekTo(seconds) {
    const video = $(SEL.video);
    if (!video || !isFinite(video.duration)) return;
    video.currentTime = Math.max(0, Math.min(seconds, video.duration - 0.5));
  }

  // ---- Search ----
  // Uses YT Music's own search box, so the tab never reloads and the music keeps playing.
  // Everything that depends on how the search page is built is in this block.
  const SEARCH_INPUT = "ytmusic-search-box input";
  const SEARCH_ROWS = "ytmusic-search-page ytmusic-responsive-list-item-renderer";
  const SEARCH_TOP = "ytmusic-search-page ytmusic-card-shelf-renderer";
  const MAX_RESULTS = 20;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const squash = (text) => (text || "").replace(/\s+/g, " ").trim();
  const textIn = (el, selector) => squash((el.querySelector(selector) || {}).textContent);

  // The results currently on the page: [{ title, details, el }]
  function readResults() {
    const out = [];
    const seen = new Set();
    const add = (el, title, details) => {
      if (!title) return;
      const key = title + "|" + details;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ title: title, details: details, el: el });
    };
    const top = document.querySelector(SEARCH_TOP);
    if (top) add(top, textIn(top, ".title"), textIn(top, ".subtitle"));
    document.querySelectorAll(SEARCH_ROWS).forEach((row) => {
      add(row, textIn(row, ".title"), textIn(row, ".secondary-flex-columns"));
    });
    return out.slice(0, MAX_RESULTS);
  }

  const signature = (rows) => rows.map((r) => r.title + "|" + r.details).join("\n");

  // Types the text into the search box and presses Enter
  function submitSearch(input, text) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    input.focus();
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    const key = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, composed: true, cancelable: true };
    input.dispatchEvent(new KeyboardEvent("keydown", key));
    input.dispatchEvent(new KeyboardEvent("keypress", key));
    input.dispatchEvent(new KeyboardEvent("keyup", key));
  }

  // Resolves to { ok: true, results: [{title, details}] } or { ok: false, err }
  async function search(q) {
    const input = $(SEARCH_INPUT);
    if (!input) return { ok: false, err: "nosearch" };

    const before = signature(readResults());
    const wasOnSearch = location.pathname.indexOf("/search") === 0;
    const previousQ = wasOnSearch ? new URLSearchParams(location.search).get("q") : null;
    submitSearch(input, q);

    // The old results stay on the page for a moment after the address changes, so a list only
    // counts as the answer once it differs from what was there before (or it's the same search again)
    const done = (results) => ({ ok: true, results: results.map((r) => ({ title: r.title, details: r.details })) });
    let onResultsPage = false;
    const end = Date.now() + 8000;
    while (Date.now() < end) {
      await sleep(200);
      onResultsPage =
        location.pathname.indexOf("/search") === 0 && new URLSearchParams(location.search).get("q") === q;
      const rows = readResults();
      const changed = signature(rows) !== before;
      if (rows.length && ((onResultsPage && (changed || previousQ === q)) || (!onResultsPage && changed))) {
        await sleep(500); // let the rest of the list finish loading
        return done(readResults());
      }
    }
    const rows = readResults();
    if (onResultsPage && rows.length) return done(rows); // a different search that happens to list the same songs
    return { ok: false, err: onResultsPage ? "empty" : "timeout" };
  }

  // Plays result number `index`, but only if it still has the title the phone saw
  // (the page may have moved on since).
  function playResult(index, title) {
    const hit = readResults()[index];
    if (!hit) return false;
    if (hit.title.slice(0, title.length) !== title) return false;
    const button = hit.el.querySelector("ytmusic-play-button-renderer");
    const target = (button && (button.querySelector("#play-button") || button)) || hit.el;
    target.click();
    return true;
  }

  function getState() {
    const video = $(SEL.video);
    const meta = navigator.mediaSession && navigator.mediaSession.metadata;

    const title = (meta && meta.title) || textOf(SEL.title);

    let artist = (meta && meta.artist) || "";
    if (!artist) {
      // The byline looks like "Artist • Album • Year"
      artist = textOf(SEL.byline).split("•")[0].trim();
    }

    let artwork = "";
    if (meta && meta.artwork && meta.artwork.length) {
      artwork = meta.artwork[meta.artwork.length - 1].src || "";
    }

    return {
      title: title,
      artist: artist,
      album: (meta && meta.album) || "",
      artwork: artwork,
      playing: isPlaying(),
      position: video ? video.currentTime : 0,
      duration: video && isFinite(video.duration) ? video.duration : 0,
      volume: getVolume(),
    };
  }

  window.YTMAdapter = {
    getState: getState,
    play: function () {
      if (!isPlaying()) clickButton(SEL.playPause);
    },
    pause: function () {
      if (isPlaying()) clickButton(SEL.playPause);
    },
    toggle: function () {
      clickButton(SEL.playPause);
    },
    next: function () {
      clickButton(SEL.next);
    },
    previous: function () {
      clickButton(SEL.previous);
    },
    getVolume: getVolume,
    setVolume: setVolume,
    getQueue: getQueue,
    jumpTo: jumpTo,
    seekTo: seekTo,
    search: search,
    playResult: playResult,
  };
})();
