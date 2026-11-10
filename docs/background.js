// background.js
// The laptop side of the connection. Runs as the extension's service worker.
//
//   phone  <-- encrypted, via public brokers -->  this file  <-- tabs.sendMessage -->  content.js
//
// - Keeps the pairing code (made once, stored in chrome.storage.local).
// - Holds the connection to the brokers (carrier.js).
// - Passes the phone's commands to the YT Music tab, but only the fixed list
//   below, and sends the player state back.
//
// Chrome 116+ keeps an extension worker alive while it has an open WebSocket
// that sends or receives something at least every 30 seconds. carrier.js pings
// every 15 seconds for exactly that. The alarm below is the safety net: if the
// worker was shut down anyway, it wakes up and reconnects.

importScripts("carrier.js");

const COMMANDS = ["play", "pause", "toggle", "next", "previous", "volumeUp", "volumeDown"];
const YT_MUSIC = "https://music.youtube.com/*";
const ALARM = "ytmr-tick";
const HEARTBEAT_MS = 15000; // the phone treats the laptop as gone after ~40s of silence
const POLL_MS = 2000; // how often we look for song changes to push to the phone
const MAX_COMMANDS_PER_3S = 10;
const MAX_VOLUME_PER_3S = 30; // a slider sends many small updates
let recentVolume = [];
let volumeTimer = null;

const MAX_SEARCHES_PER_10S = 5;
let recentSearches = [];
let lastQuery = "";

let code = null;
let link = null;
let generation = 0; // bumps whenever the link is rebuilt, so late results can be ignored
let lastSent = "";
let lastQueue = "";
let polling = false;
let recentCommands = [];

// ---------- Finding the player ----------

async function findTab() {
  const tabs = await chrome.tabs.query({ url: YT_MUSIC });
  if (!tabs.length) return null;
  return tabs.find((t) => t.audible) || tabs.find((t) => t.active) || tabs[0];
}

// Only these fields leave the laptop, and only as plain values
function forPhone(state) {
  const s = state && typeof state === "object" ? state : {};
  const artwork = typeof s.artwork === "string" && /^https:\/\//.test(s.artwork) && s.artwork.length <= 500 ? s.artwork : "";
  return {
    tab: true,
    title: typeof s.title === "string" ? s.title.slice(0, 200) : "",
    artist: typeof s.artist === "string" ? s.artist.slice(0, 200) : "",
    artwork: artwork,
    playing: s.playing === true,
    volume: typeof s.volume === "number" && isFinite(s.volume) ? Math.round(s.volume) : 0,
    pos: typeof s.position === "number" && isFinite(s.position) && s.position >= 0 ? Math.round(s.position) : 0,
    dur: typeof s.duration === "number" && isFinite(s.duration) && s.duration >= 0 ? Math.round(s.duration) : 0,
  };
}

// The queue is sent as compact rows [title, artist, duration] around the current song,
// trimmed so the encrypted message always fits under carrier.js's size limit.
const MAX_QUEUE_SEND = 150;
const MAX_QUEUE_BYTES = 24000;
const bytesOf = (value) => new TextEncoder().encode(JSON.stringify(value)).length;

function forPhoneQueue(q) {
  const list = q && Array.isArray(q.items) ? q.items : [];
  const cur = q && Number.isInteger(q.cur) ? q.cur : -1;
  const from = cur > 10 ? cur - 10 : 0; // a few songs before the current one
  const items = list.slice(from, from + MAX_QUEUE_SEND).map((it) => [
    String((it && it.title) || "").slice(0, 60),
    String((it && it.artist) || "").slice(0, 40),
    String((it && it.duration) || "").slice(0, 8),
  ]);
  while (items.length > 1 && bytesOf({ from: from, cur: cur, items: items }) > MAX_QUEUE_BYTES) items.pop();
  return { from: from, cur: cur, items: items };
}

async function readQueue() {
  const tab = await findTab();
  if (!tab) return null;
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: "GET_QUEUE" });
    if (res && res.ok && res.queue) return forPhoneQueue(res.queue);
  } catch (err) {
    // content script isn't there; the phone keeps its last queue
  }
  return null;
}

async function readState() {
  const tab = await findTab();
  if (!tab) return { tab: false, refresh: false };
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: "GET_STATE" });
    if (res && res.ok && res.state) return forPhone(res.state);
  } catch (err) {
    // content script isn't there
  }
  // A YT Music tab exists but the extension isn't attached to it yet
  // (typical right after installing or reloading the extension)
  return { tab: false, refresh: true };
}

// ---------- Talking to the phone ----------

// The song position changes every second, so it is left out of the "did anything change?"
// check. The phone moves its own bar along; we only resend when the position jumps
// (a seek on the laptop) or on the regular heartbeat.
let posSent = 0;
let posSentAt = 0;

function withoutPos(state) {
  return JSON.stringify(Object.assign({}, state, { pos: 0 }));
}

function positionJumped(state) {
  if (!state.tab) return false;
  const expected = posSent + (state.playing ? (Date.now() - posSentAt) / 1000 : 0);
  return Math.abs(state.pos - expected) > 3;
}

async function publishState(force) {
  const current = link;
  if (!current || current.status().connected === 0) return;
  const state = await readState();
  const sig = withoutPos(state);
  if (!force && sig === lastSent && !positionJumped(state)) return;
  lastSent = sig;
  posSent = state.pos || 0;
  posSentAt = Date.now();
  current.send({ type: "state", state: state });
}

async function publishQueue(force) {
  const current = link;
  if (!current || current.status().connected === 0) return;
  const queue = await readQueue();
  if (!queue) return;
  const json = JSON.stringify(queue);
  if (!force && json === lastQueue) return;
  lastQueue = json;
  current.send({ type: "queue", queue: queue });
}

async function runCommand(command, extra) {
  const current = link;
  if (!current) return;

  if (command === "search") {
    runSearch(extra.q);
    return;
  }

  if (command === "playResult") {
    runPlayResult(extra);
    return;
  }

  if (command === "volume") {
    // A slider sends many updates: apply each one, but tell the phone just once afterwards
    const volTab = await findTab();
    if (volTab) {
      try {
        await chrome.tabs.sendMessage(volTab.id, { type: "COMMAND", command: "volume", level: extra.level });
      } catch (err) {
        // content script isn't there
      }
    }
    clearTimeout(volumeTimer);
    volumeTimer = setTimeout(() => publishState(false), 500);
    return;
  }

  let state;
  const tab = await findTab();
  if (!tab) {
    state = { tab: false, refresh: false };
  } else {
    try {
      const res = await chrome.tabs.sendMessage(tab.id, Object.assign({ type: "COMMAND", command: command }, extra || {}));
      state = res && res.ok && res.state ? forPhone(res.state) : await readState();
    } catch (err) {
      state = { tab: false, refresh: true };
    }
  }
  lastSent = withoutPos(state);
  posSent = state.pos || 0;
  posSentAt = Date.now();
  current.send({ type: "state", state: state });
  if (command === "jump") {
    // YT Music takes a moment to switch songs; then tell the phone the new queue position
    setTimeout(() => {
      publishState(false);
      publishQueue(false);
    }, 1200);
  }
}

// ---------- Search ----------

// Asks the YT Music tab to search, then sends the phone the list of results
async function runSearch(q) {
  const current = link;
  if (!current) return;

  const now = Date.now();
  recentSearches = recentSearches.filter((t) => now - t < 10000);
  if (recentSearches.length >= MAX_SEARCHES_PER_10S) {
    current.send({ type: "results", q: q, err: "slow", items: [] });
    return;
  }
  recentSearches.push(now);

  lastQuery = q;
  const reply = { type: "results", q: q, err: "notab", items: [] };
  const tab = await findTab();
  if (tab) {
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { type: "SEARCH", q: q });
      if (res && res.ok && Array.isArray(res.results)) {
        reply.err = "";
        reply.items = res.results.slice(0, 20).map((r) => [
          String((r && r.title) || "").slice(0, 60),
          String((r && r.details) || "").slice(0, 80),
        ]);
      } else {
        reply.err = res && typeof res.err === "string" ? res.err.slice(0, 12) : "nosearch";
      }
    } catch (err) {
      reply.err = "refresh"; // the tab doesn't have the extension attached yet
    }
  }
  current.send(reply);
}

// Plays one of the results from the last search
async function runPlayResult(extra) {
  const current = link;
  if (!current) return;

  let ok = false;
  const tab = await findTab();
  if (tab) {
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { type: "PLAY_RESULT", index: extra.index, title: extra.title });
      ok = !!(res && res.ok);
    } catch (err) {
      // content script isn't there
    }
  }

  if (!ok) {
    // What's on the laptop no longer matches what the phone showed
    current.send({ type: "results", q: lastQuery, err: "changed", items: [] });
    return;
  }
  // YT Music takes a moment to start the song; then tell the phone
  setTimeout(() => {
    publishState(true);
    publishQueue(false);
  }, 1200);
}

function onPhoneMessage(msg) {
  if (msg.type === "sync") {
    publishState(true);
    publishQueue(true);
    return;
  }

  if (msg.type === "cmd") {
    if (typeof msg.cmd !== "string") return;

    // Commands with parameters are checked strictly; every other command must be in our list
    let extra = {};
    if (msg.cmd === "jump") {
      const valid =
        Number.isInteger(msg.index) && msg.index >= 0 && msg.index < 500 &&
        typeof msg.title === "string" && msg.title.length <= 60;
      if (!valid) return;
      extra = { index: msg.index, title: msg.title };
    } else if (msg.cmd === "volume") {
      if (!(Number.isInteger(msg.level) && msg.level >= 0 && msg.level <= 100)) return;
      extra = { level: msg.level };
    } else if (msg.cmd === "seek") {
      if (!(Number.isInteger(msg.pos) && msg.pos >= 0 && msg.pos <= 86400)) return;
      extra = { pos: msg.pos };
    } else if (msg.cmd === "search") {
      const q = typeof msg.q === "string" ? msg.q.trim() : "";
      if (!q || q.length > 80 || /[\u0000-\u001f\u007f]/.test(q)) return;
      extra = { q: q };
    } else if (msg.cmd === "playResult") {
      const valid =
        Number.isInteger(msg.index) && msg.index >= 0 && msg.index < 20 &&
        typeof msg.title === "string" && msg.title.length <= 60;
      if (!valid) return;
      extra = { index: msg.index, title: msg.title };
    } else if (COMMANDS.indexOf(msg.cmd) === -1) {
      return;
    }

    // Rate limits. Volume gets its own, higher limit because a slider sends many updates.
    const now = Date.now();
    if (msg.cmd === "volume") {
      recentVolume = recentVolume.filter((t) => now - t < 3000);
      if (recentVolume.length >= MAX_VOLUME_PER_3S) return;
      recentVolume.push(now);
    } else {
      recentCommands = recentCommands.filter((t) => now - t < 3000);
      if (recentCommands.length >= MAX_COMMANDS_PER_3S) return;
      recentCommands.push(now);
    }

    runCommand(msg.cmd, extra);
  }
}

// ---------- Pairing code and connection ----------

async function connect(newCode) {
  const mine = ++generation;
  if (link) {
    link.close();
    link = null;
  }
  code = newCode;
  lastSent = "";
  lastQueue = "";

  const base = await Carrier.topicBase(newCode);
  if (mine !== generation) return; // a newer code replaced this one while we were working

  link = Carrier.createLink({
    role: "laptop",
    base: base,
    onMessage: onPhoneMessage,
    onStatus: function () {},
    // As soon as we're online, tell the phone what's playing
    onConnect: function () {
      publishState(true);
      publishQueue(true);
    },
  });
}

async function start() {
  const stored = await chrome.storage.local.get("code");
  let saved = Carrier.normalizeCode(stored.code);
  if (!saved) {
    saved = Carrier.generateCode();
    await chrome.storage.local.set({ code: saved });
  }

  // Wake the worker up regularly in case Chrome shut it down
  const alarm = await chrome.alarms.get(ALARM);
  if (!alarm) chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });

  await connect(saved);
}

function pairing() {
  const s = link ? link.status() : { connected: 0, total: Carrier.BROKERS.length };
  return { code: Carrier.formatCode(code), connected: s.connected, total: s.total };
}

const ready = start().catch(function (err) {
  console.error("YT Music Remote could not start:", err);
});

// ---------- Listeners (must be registered right away, not after an await) ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only the extension's own pages (the popup). Never content scripts or web pages.
  if (sender.id !== chrome.runtime.id || sender.tab) return;
  if (!msg || typeof msg.type !== "string") return;

  if (msg.type === "GET_PAIRING") {
    ready.then(() => sendResponse(pairing()));
    return true;
  }

  if (msg.type === "NEW_CODE") {
    ready
      .then(async () => {
        const fresh = Carrier.generateCode();
        await chrome.storage.local.set({ code: fresh });
        await connect(fresh);
        sendResponse(pairing());
      })
      .catch(() => sendResponse(pairing()));
    return true;
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM) return;
  ready.then(() => {
    if (link) link.nudge();
  });
});

// Having these listeners makes Chrome start the worker when the browser opens
chrome.runtime.onStartup.addListener(() => {});
// Chrome only attaches the extension to YT Music tabs opened AFTER it was installed or updated.
// So at install/update time we attach to the ones that are already open, and nobody has to refresh.
async function attachToOpenTabs() {
  const tabs = await chrome.tabs.query({ url: YT_MUSIC });
  for (const tab of tabs) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "GET_STATE" });
      continue; // already attached
    } catch (err) {
      // not attached yet
    }
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["adapter.js", "content.js"] });
    } catch (err) {
      // the tab can't be reached (for example it is still loading); a refresh will fix it
    }
  }
}

chrome.runtime.onInstalled.addListener(() => {
  attachToOpenTabs();
});

// Heartbeat: tells the phone the laptop is alive, even when nothing changes
setInterval(() => publishState(true), HEARTBEAT_MS);

// Pushes song changes (including ones you make on the laptop) to the phone
setInterval(async () => {
  if (polling) return;
  polling = true;
  try {
    await publishState(false);
    await publishQueue(false);
  } finally {
    polling = false;
  }
}, POLL_MS);
