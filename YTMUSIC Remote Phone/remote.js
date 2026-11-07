// remote.js
// Phone remote UI.
//
// The UI talks to a "transport": something with start(), send(command), stop().
// There are two: a demo one with fake songs (open the page with ?demo), and the
// real one, which connects through carrier.js to the extension on your laptop.

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  // Same fixed command set the extension accepts, and nothing else
  const COMMANDS = ["play", "pause", "toggle", "next", "previous", "volumeUp", "volumeDown"];
  const VOLUME_STEP = 10;
  const CODE_KEY = "ytmr.code";
  const LIVE_WINDOW_MS = 40000; // laptop sends a heartbeat every 15s; miss two and it's gone

  // ---------- Rendering (plain text only, never innerHTML) ----------

  // State arrives over the network, so check every field before showing it
  function clean(state) {
    const s = state && typeof state === "object" ? state : {};
    return {
      tab: s.tab !== false,
      refresh: s.refresh === true,
      title: typeof s.title === "string" ? s.title.slice(0, 200) : "",
      artist: typeof s.artist === "string" ? s.artist.slice(0, 200) : "",
      artwork: typeof s.artwork === "string" ? s.artwork.slice(0, 500) : "",
      playing: s.playing === true,
      volume: typeof s.volume === "number" && isFinite(s.volume) ? Math.round(s.volume) : null,
      hue: typeof s.hue === "number" ? s.hue : null,
    };
  }

  function render(raw) {
    const state = clean(raw);
    const art = $("art");

    if (!state.tab) {
      $("title").textContent = state.refresh
        ? "Refresh YouTube Music on your laptop"
        : "Open YouTube Music on your laptop";
      $("artist").textContent = "";
      $("toggle").dataset.playing = "false";
      $("vol").textContent = "–";
      art.style.backgroundImage = "none";
      return;
    }

    $("title").textContent = state.title || "Nothing playing";
    $("artist").textContent = state.artist;
    $("toggle").dataset.playing = state.playing ? "true" : "false";
    $("vol").textContent = state.volume === null ? "–" : state.volume + "%";

    if (/^https:\/\//.test(state.artwork)) {
      art.style.backgroundImage = 'url("' + state.artwork.replace(/"/g, "%22") + '")';
    } else if (state.hue !== null) {
      art.style.backgroundImage =
        "linear-gradient(135deg, hsl(" + state.hue + " 70% 45%), hsl(" + ((state.hue + 60) % 360) + " 70% 25%))";
    } else {
      art.style.backgroundImage = "none";
    }
  }

  function setStatus(text, kind, live) {
    const el = $("status");
    el.textContent = text;
    el.dataset.kind = kind;
    document.body.dataset.live = live ? "true" : "false";
  }

  // ---------- Demo transport (fake data, for trying the layout) ----------

  function createDemoTransport() {
    const songs = [
      { title: "Midnight Drive", artist: "The Neon Hours", hue: 265 },
      { title: "Paper Lanterns", artist: "Aster & Moss", hue: 20 },
      { title: "Slow Tide", artist: "Harbor Lights", hue: 195 },
      { title: "Golden Static", artist: "Velvet Circuit", hue: 45 },
      { title: "Northbound", artist: "Pine & Ember", hue: 140 },
    ];
    let index = 0;
    let playing = true;
    let volume = 60;

    function show() {
      const s = songs[index];
      render({ tab: true, title: s.title, artist: s.artist, hue: s.hue, playing: playing, volume: volume });
    }

    return {
      start: function () {
        setStatus("Demo mode", "demo", true);
        show();
      },
      send: function (command) {
        switch (command) {
          case "play":
            playing = true;
            break;
          case "pause":
            playing = false;
            break;
          case "toggle":
            playing = !playing;
            break;
          case "next":
            index = (index + 1) % songs.length;
            playing = true;
            break;
          case "previous":
            index = (index - 1 + songs.length) % songs.length;
            playing = true;
            break;
          case "volumeUp":
            volume = Math.min(100, volume + VOLUME_STEP);
            break;
          case "volumeDown":
            volume = Math.max(0, volume - VOLUME_STEP);
            break;
        }
        show();
      },
      stop: function () {},
    };
  }

  // ---------- Real transport (through the public brokers) ----------

  function createLinkTransport(code) {
    let link = null;
    let timer = null;
    let lastLiveAt = 0;
    let ticks = 0;
    let info = { connected: 0, total: 0 };

    function isLive() {
      return Date.now() - lastLiveAt < LIVE_WINDOW_MS;
    }

    function refreshStatus() {
      if (info.connected === 0) setStatus("Connecting…", "wait", false);
      else if (!isLive()) setStatus("Waiting for your laptop…", "wait", false);
      else setStatus("Connected", "ok", true);
    }

    // Phones put pages to sleep and switch networks; reconnect when we wake up
    function wake() {
      if (!link) return;
      link.nudge();
      link.send({ type: "sync" });
    }
    function onVisible() {
      if (document.visibilityState === "visible") wake();
    }

    return {
      start: async function () {
        refreshStatus();
        const base = await Carrier.topicBase(code);
        link = Carrier.createLink({
          role: "phone",
          base: base,
          onMessage: function (msg) {
            if (msg.type === "state" && msg.state) {
              lastLiveAt = Date.now();
              render(msg.state);
              refreshStatus();
            }
          },
          onStatus: function (s) {
            info = s;
            refreshStatus();
          },
          // Ask the laptop for its current state as soon as a connection opens
          onConnect: function () {
            link.send({ type: "sync" });
          },
        });

        timer = setInterval(function () {
          ticks++;
          refreshStatus();
          // While waiting, ask again every 5 seconds
          if (info.connected > 0 && !isLive() && ticks % 5 === 0) link.send({ type: "sync" });
        }, 1000);

        document.addEventListener("visibilitychange", onVisible);
        window.addEventListener("online", wake);
      },
      send: function (command) {
        if (!link || !isLive()) return;
        link.send({ type: "cmd", cmd: command });
      },
      stop: function () {
        clearInterval(timer);
        document.removeEventListener("visibilitychange", onVisible);
        window.removeEventListener("online", wake);
        if (link) link.close();
        link = null;
      },
    };
  }

  // ---------- Screens and wiring ----------

  let transport = null;

  function loadCode() {
    try {
      return Carrier.normalizeCode(localStorage.getItem(CODE_KEY));
    } catch (e) {
      return null;
    }
  }

  function saveCode(code) {
    try {
      localStorage.setItem(CODE_KEY, code);
    } catch (e) {
      // private mode: it will just ask again next time
    }
  }

  function forgetCode() {
    try {
      localStorage.removeItem(CODE_KEY);
    } catch (e) {
      // nothing to do
    }
  }

  function showPairing() {
    $("remote").hidden = true;
    $("pair").hidden = false;
    $("pairError").textContent = "";
    $("code").focus();
  }

  function showRemote() {
    $("pair").hidden = true;
    $("remote").hidden = false;
  }

  async function startPaired(code) {
    showRemote();
    if (transport) transport.stop();
    transport = createLinkTransport(code);
    await transport.start();
  }

  $("code").addEventListener("input", function () {
    const raw = $("code").value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
    const groups = raw.match(/.{1,4}/g);
    $("code").value = groups ? groups.join("-") : "";
  });

  $("pairForm").addEventListener("submit", function (event) {
    event.preventDefault();
    const code = Carrier.normalizeCode($("code").value);
    if (!code) {
      $("pairError").textContent = "That doesn't look right. The code is 12 letters and numbers.";
      return;
    }
    saveCode(code);
    startPaired(code);
  });

  $("unpair").addEventListener("click", function () {
    if (transport) transport.stop();
    transport = null;
    forgetCode();
    showPairing();
  });

  document.querySelectorAll("button[data-cmd]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      const command = btn.dataset.cmd;
      if (COMMANDS.indexOf(command) === -1) return;
      if (navigator.vibrate) navigator.vibrate(10);
      if (transport) transport.send(command);
    });
  });

  // ---------- Start ----------

  if (new URLSearchParams(location.search).has("demo")) {
    showRemote();
    transport = createDemoTransport();
    transport.start();
  } else {
    const saved = loadCode();
    if (saved) startPaired(saved);
    else showPairing();
  }

  // Service worker only works over https (or localhost), not when opening the file directly
  if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register("sw.js").catch(function () {});
  }
})();
