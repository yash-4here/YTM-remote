(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const COMMANDS = ["play", "pause", "toggle", "next", "previous", "volumeUp", "volumeDown"];
  const VOLUME_STEP = 10;
  const CODE_KEY = "ytmr.code";
  const LIVE_WINDOW_MS = 40000; 

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
      pos: typeof s.pos === "number" && isFinite(s.pos) && s.pos >= 0 ? Math.round(s.pos) : 0,
      dur: typeof s.dur === "number" && isFinite(s.dur) && s.dur >= 0 ? Math.round(s.dur) : 0,
      hue: typeof s.hue === "number" ? s.hue : null,
    };
  }

  function render(raw) {
    const state = clean(raw);
    const art = $("art");

    if (!state.tab) {
      showProgress(0, 0, false);
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
    if (state.volume !== null) showVolume(state.volume);
    showProgress(state.pos, state.dur, state.playing);

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

  let queue = { from: 0, cur: -1, items: [] };

  function cleanQueue(q) {
    const s = q && typeof q === "object" ? q : {};
    const items = (Array.isArray(s.items) ? s.items : []).slice(0, 200).map(function (it) {
      const a = Array.isArray(it) ? it : [];
      return {
        title: typeof a[0] === "string" ? a[0].slice(0, 60) : "",
        artist: typeof a[1] === "string" ? a[1].slice(0, 40) : "",
        duration: typeof a[2] === "string" ? a[2].slice(0, 8) : "",
      };
    });
    return {
      from: Number.isInteger(s.from) && s.from >= 0 ? s.from : 0,
      cur: Number.isInteger(s.cur) ? s.cur : -1,
      items: items,
    };
  }

  function renderQueue() {
    const list = $("queueList");
    const top = list.scrollTop;
    list.textContent = "";
    $("queueEmpty").hidden = queue.items.length > 0;

    queue.items.forEach(function (it, i) {
      const pos = queue.from + i;
      const row = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "queue-item" + (pos === queue.cur ? " current" : pos < queue.cur ? " past" : "");

      const num = document.createElement("span");
      num.className = "queue-num";
      num.textContent = pos === queue.cur ? "▶" : String(pos + 1);

      const text = document.createElement("span");
      text.className = "queue-text";
      const title = document.createElement("span");
      title.className = "queue-title";
      title.textContent = it.title || "Untitled";
      const artist = document.createElement("span");
      artist.className = "queue-artist";
      artist.textContent = it.artist;
      text.append(title, artist);

      const dur = document.createElement("span");
      dur.className = "queue-dur";
      dur.textContent = it.duration;

      btn.append(num, text, dur);
      btn.addEventListener("click", function () {
        if (navigator.vibrate) navigator.vibrate(10);
        if (transport) transport.send("jump", { index: pos, title: it.title });
      });
      row.append(btn);
      list.append(row);
    });
    list.scrollTop = top;
  }

  function setQueue(raw) {
    queue = cleanQueue(raw);
    if (!$("queuePanel").hidden) renderQueue();
  }

  function openQueue() {
    $("queuePanel").hidden = false;
    renderQueue();
    const current = $("queueList").querySelector(".current");
    if (current) current.scrollIntoView({ block: "center" });
    if (transport && transport.sync) transport.sync(); 
  }

  function closeQueue() {
    $("queuePanel").hidden = true;
  }

  let sliderBusyUntil = 0; 
  let lastVolumeSent = 0;
  let volumeTimer = null;

  function showVolume(level) {
    if (Date.now() < sliderBusyUntil) return;
    $("volSlider").value = String(level);
    $("vol").textContent = level + "%";
  }

  function sendVolume(level) {
    lastVolumeSent = Date.now();
    if (transport) transport.send("volume", { level: level });
  }

  $("volSlider").addEventListener("input", function () {
    const level = Math.round(Number($("volSlider").value));
    $("vol").textContent = level + "%";
    sliderBusyUntil = Date.now() + 1500;
    clearTimeout(volumeTimer);
    if (Date.now() - lastVolumeSent >= 200) {
      sendVolume(level);
    } else {
      volumeTimer = setTimeout(function () {
        sendVolume(level);
      }, 200);
    }
  });

  let progress = { pos: 0, dur: 0, playing: false, at: 0 };
  let progressBusyUntil = 0; 

  function formatTime(total) {
    const s = Math.max(0, Math.floor(total));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, "0");
    return h > 0 ? h + ":" + String(m).padStart(2, "0") + ":" + sec : m + ":" + sec;
  }

  function drawProgress() {
    if (Date.now() < progressBusyUntil) return;
    const dur = progress.dur;
    let pos = progress.pos;
    if (progress.playing) pos += (Date.now() - progress.at) / 1000;
    pos = Math.min(pos, dur);
    const bar = $("progSlider");
    bar.disabled = dur <= 0;
    bar.max = String(dur);
    bar.value = String(Math.floor(pos));
    $("posNow").textContent = formatTime(pos);
    $("posTotal").textContent = formatTime(dur);
  }

  function showProgress(pos, dur, playing) {
    progress = { pos: pos || 0, dur: dur || 0, playing: !!playing, at: Date.now() };
    drawProgress();
  }

  setInterval(drawProgress, 500);

  $("progSlider").addEventListener("input", function () {
    progressBusyUntil = Date.now() + 10000;
    $("posNow").textContent = formatTime(Number($("progSlider").value));
  });

  $("progSlider").addEventListener("change", function () {
    const pos = Math.round(Number($("progSlider").value));
    progress.pos = pos;
    progress.at = Date.now();
    progressBusyUntil = Date.now() + 1500; 
    if (transport) transport.send("seek", { pos: pos });
  });
  
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
      setQueue({ from: 0, cur: index, items: songs.map(function (x) { return [x.title, x.artist, "3:30"]; }) });
    }

    return {
      start: function () {
        setStatus("Demo mode", "demo", true);
        show();
      },
      send: function (command, extra) {
        switch (command) {
          case "jump":
            if (extra && Number.isInteger(extra.index) && extra.index >= 0 && extra.index < songs.length) {
              index = extra.index;
              playing = true;
            }
            break;
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
            } else if (msg.type === "queue" && msg.queue) {
              setQueue(msg.queue);
            }
          },
          onStatus: function (s) {
            info = s;
            refreshStatus();
          },
          onConnect: function () {
            link.send({ type: "sync" });
          },
        });

        timer = setInterval(function () {
          ticks++;
          refreshStatus();
          if (info.connected > 0 && !isLive() && ticks % 5 === 0) link.send({ type: "sync" });
        }, 1000);

        document.addEventListener("visibilitychange", onVisible);
        window.addEventListener("online", wake);
      },
      send: function (command, extra) {
        if (!link || !isLive()) return;
        link.send(Object.assign({ type: "cmd", cmd: command }, extra || {}));
      },
      sync: function () {
        if (link) link.send({ type: "sync" });
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
    }
  }

  function forgetCode() {
    try {
      localStorage.removeItem(CODE_KEY);
    } catch (e) {
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
    closeQueue();
    queue = { from: 0, cur: -1, items: [] };
    renderQueue();
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

  $("queueOpen").addEventListener("click", openQueue);
  $("queueClose").addEventListener("click", closeQueue);
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") closeQueue();
  });

  if (new URLSearchParams(location.search).has("demo")) {
    showRemote();
    transport = createDemoTransport();
    transport.start();
  } else {
    const saved = loadCode();
    if (saved) startPaired(saved);
    else showPairing();
  }

  if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register("sw.js").catch(function () {});
  }
})();
