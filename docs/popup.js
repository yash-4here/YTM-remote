// popup.js
// Pairing code and status at the top, plus a small local player for testing.

const $ = (id) => document.getElementById(id);

// ---------- QR code generator (byte mode, error correction M, versions 1-6) ----------
const QR = (function () {
  // [data codewords, error-correction codewords per block, number of blocks]
  const SPEC = [null, [16, 10, 1], [28, 16, 1], [44, 26, 1], [64, 18, 2], [86, 24, 2], [108, 16, 4]];
  const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34]];

  // Arithmetic for the error-correction codes
  const EXP = [];
  const LOG = [];
  for (let i = 0, x = 1; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 256) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

  function rsRemainder(data, n) {
    let g = [1];
    for (let i = 0; i < n; i++) {
      const next = new Array(g.length + 1).fill(0);
      for (let j = 0; j < g.length; j++) {
        next[j] ^= g[j];
        next[j + 1] ^= mul(g[j], EXP[i]);
      }
      g = next;
    }
    const rem = new Array(n).fill(0);
    for (const b of data) {
      const f = b ^ rem.shift();
      rem.push(0);
      for (let i = 0; i < n; i++) rem[i] ^= mul(g[i + 1], f);
    }
    return rem;
  }

  // The text as bytes, plus error-correction bytes, in the order they are placed
  function codewords(bytes, version) {
    const [cap, ec, blocks] = SPEC[version];
    const bits = [];
    const put = (value, length) => {
      for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
    };
    put(4, 4); // byte mode
    put(bytes.length, 8);
    bytes.forEach((b) => put(b, 8));
    put(0, Math.min(4, cap * 8 - bits.length)); // terminator
    while (bits.length % 8) bits.push(0);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(""), 2));
    for (let pad = 0xec; data.length < cap; pad ^= 0xec ^ 0x11) data.push(pad);

    const per = cap / blocks;
    const dataBlocks = [];
    const ecBlocks = [];
    for (let b = 0; b < blocks; b++) {
      const d = data.slice(b * per, (b + 1) * per);
      dataBlocks.push(d);
      ecBlocks.push(rsRemainder(d, ec));
    }
    const out = [];
    for (let i = 0; i < per; i++) dataBlocks.forEach((d) => out.push(d[i]));
    for (let i = 0; i < ec; i++) ecBlocks.forEach((e) => out.push(e[i]));
    return out;
  }

  function formatBits(mask) {
    let rem = mask; // error-correction level M is 00, so the 5 bits are just the mask
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    return ((mask << 10) | rem) ^ 0x5412;
  }

  function drawFormat(m, fn, mask) {
    const n = m.length;
    const bits = formatBits(mask);
    const put = (r, c, i) => {
      m[r][c] = ((bits >>> i) & 1) === 1;
      fn[r][c] = true;
    };
    for (let i = 0; i <= 5; i++) put(i, 8, i);
    put(7, 8, 6);
    put(8, 8, 7);
    put(8, 7, 8);
    for (let i = 9; i < 15; i++) put(8, 14 - i, i);
    for (let i = 0; i < 8; i++) put(8, n - 1 - i, i);
    for (let i = 8; i < 15; i++) put(n - 15 + i, 8, i);
    m[n - 8][8] = true; // the one module that is always dark
    fn[n - 8][8] = true;
  }

  // Fixed patterns plus the data, before any mask is applied
  function baseMatrix(version, stream) {
    const n = 17 + 4 * version;
    const m = Array.from({ length: n }, () => new Array(n).fill(false));
    const fn = Array.from({ length: n }, () => new Array(n).fill(false));
    const set = (r, c, dark) => {
      m[r][c] = dark;
      fn[r][c] = true;
    };
    for (let i = 0; i < n; i++) {
      set(6, i, i % 2 === 0);
      set(i, 6, i % 2 === 0);
    }
    const finder = (cr, cc) => {
      for (let dr = -4; dr <= 4; dr++) {
        for (let dc = -4; dc <= 4; dc++) {
          const r = cr + dr;
          const c = cc + dc;
          if (r < 0 || r >= n || c < 0 || c >= n) continue;
          const d = Math.max(Math.abs(dr), Math.abs(dc));
          set(r, c, d !== 2 && d !== 4);
        }
      }
    };
    finder(3, 3);
    finder(3, n - 4);
    finder(n - 4, 3);
    for (const r of ALIGN[version]) {
      for (const c of ALIGN[version]) {
        if ((r === 6 && c === 6) || (r === 6 && c === n - 7) || (r === n - 7 && c === 6)) continue;
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        }
      }
    }
    drawFormat(m, fn, 0); // reserves the format-information area

    let i = 0;
    const total = stream.length * 8;
    for (let right = n - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < n; vert++) {
        for (let j = 0; j < 2; j++) {
          const c = right - j;
          const r = ((right + 1) & 2) === 0 ? n - 1 - vert : vert;
          if (!fn[r][c] && i < total) {
            m[r][c] = ((stream[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
            i++;
          }
        }
      }
    }
    return { m: m, fn: fn };
  }

  const MASKS = [
    (r, c) => (r + c) % 2 === 0,
    (r, c) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];

  // The mask that leaves the least confusing pattern wins
  function penalty(m) {
    const n = m.length;
    let p = 0;
    let dark = 0;
    for (let i = 0; i < n; i++) {
      for (const line of [m[i], m.map((row) => row[i])]) {
        let run = 1;
        for (let k = 1; k <= n; k++) {
          if (k < n && line[k] === line[k - 1]) {
            run++;
          } else {
            if (run >= 5) p += run - 2;
            run = 1;
          }
        }
        const s = line.map((b) => (b ? "1" : "0")).join("");
        p += 40 * (s.match(/(?=10111010000|00001011101)/g) || []).length;
      }
    }
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (m[r][c]) dark++;
        if (r < n - 1 && c < n - 1 && m[r][c] === m[r][c + 1] && m[r][c] === m[r + 1][c] && m[r][c] === m[r + 1][c + 1]) p += 3;
      }
    }
    p += Math.max(0, Math.ceil(Math.abs(dark * 20 - n * n * 10) / (n * n)) - 1) * 10;
    return p;
  }

  // Returns rows of true/false (true = dark), or null if the text is too long (over 106 bytes)
  function encode(text) {
    const bytes = new TextEncoder().encode(text);
    let version = 1;
    while (version <= 6 && bytes.length > SPEC[version][0] - 2) version++;
    if (version > 6) return null;
    const { m: base, fn } = baseMatrix(version, codewords(bytes, version));
    let best = null;
    let bestScore = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      const m = base.map((row) => row.slice());
      for (let r = 0; r < m.length; r++) {
        for (let c = 0; c < m.length; c++) {
          if (!fn[r][c] && MASKS[mask](r, c)) m[r][c] = !m[r][c];
        }
      }
      drawFormat(m, fn, mask);
      const score = penalty(m);
      if (score < bestScore) {
        bestScore = score;
        best = m;
      }
    }
    return best;
  }

  return { encode: encode };
})();

// ---------- Pairing QR code ----------

// The phone page you host. Everyone uses it unless they choose their own address.
const DEFAULT_PHONE_URL = "https://yash-4here.github.io/YTM-remote-phone/";

let phoneUrl = DEFAULT_PHONE_URL; // can be changed with the Address button
let currentCode = "";
let qrKey = "";

function cleanAddress(text) {
  try {
    const u = new URL(String(text).trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return "";
    u.hash = "";
    return u.toString();
  } catch (err) {
    return "";
  }
}

function renderAddressUi() {
  const has = phoneUrl !== "";
  $("addrForm").hidden = has;
  $("qrLabel").hidden = !has;
  $("qr").hidden = !has;
  $("changeAddr").hidden = !has;
}

function drawQr(code) {
  if (code) currentCode = code;
  if (!phoneUrl || !currentCode) return;
  const link = phoneUrl + "#" + currentCode.replace(/-/g, "");
  if (link === qrKey) return; // nothing changed
  qrKey = link;

  const rows = QR.encode(link);
  $("qrNote").textContent = rows ? "" : "That address is too long for a QR code. Type the code below instead.";
  $("qr").hidden = !rows;
  $("qrLabel").hidden = !rows;
  if (!rows) return;

  const canvas = $("qr");
  const g = canvas.getContext("2d");
  const n = rows.length;
  const scale = Math.floor(canvas.width / (n + 8)); // 4 modules of white border on each side
  const offset = Math.floor((canvas.width - scale * n) / 2);
  g.fillStyle = "#fff";
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = "#000";
  rows.forEach((row, r) => {
    row.forEach((dark, c) => {
      if (dark) g.fillRect(offset + c * scale, offset + r * scale, scale, scale);
    });
  });
}

$("addrForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const typed = $("addr").value.trim();
  const url = typed === "" ? DEFAULT_PHONE_URL : cleanAddress(typed); // empty = back to the default
  if (!url) {
    $("addrError").textContent = "Enter the full address, starting with https://";
    return;
  }
  $("addrError").textContent = "";
  phoneUrl = url;
  qrKey = "";
  try {
    if (typed === "") await chrome.storage.local.remove("phoneUrl");
    else await chrome.storage.local.set({ phoneUrl: url });
  } catch (err) {
    // not saved; the default will be used next time
  }
  renderAddressUi();
  drawQr();
});

$("changeAddr").addEventListener("click", () => {
  $("addr").value = phoneUrl === DEFAULT_PHONE_URL ? "" : phoneUrl;
  phoneUrl = "";
  qrKey = "";
  renderAddressUi();
});

(async function loadAddress() {
  try {
    const saved = await chrome.storage.local.get("phoneUrl");
    phoneUrl = cleanAddress(saved.phoneUrl || "") || DEFAULT_PHONE_URL;
  } catch (err) {
    // keep the default
  }
  renderAddressUi();
  drawQr();
})();

// ---------- Phone pairing ----------

function showPairing(res) {
  if (!res) return;
  $("code").textContent = res.code || "…";
  $("link").textContent =
    res.connected > 0
      ? "Online · " + res.connected + " of " + res.total + " links"
      : "Connecting…";
      drawQr(res.code);
}

async function refreshPairing() {
  try {
    showPairing(await chrome.runtime.sendMessage({ type: "GET_PAIRING" }));
  } catch (err) {
    // background worker still waking up; the next tick will catch it
  }
}

$("copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("code").textContent);
    $("copy").textContent = "Copied";
    setTimeout(() => {
      $("copy").textContent = "Copy";
    }, 1500);
  } catch (err) {
    // clipboard blocked; the code is on screen to type instead
  }
});

$("newcode").addEventListener("click", async () => {
  try {
    showPairing(await chrome.runtime.sendMessage({ type: "NEW_CODE" }));
  } catch (err) {
    // ignore; try again
  }
});

// ---------- Local player (talks to the YT Music tab directly) ----------

async function findTab() {
  const tabs = await chrome.tabs.query({ url: "https://music.youtube.com/*" });
  if (!tabs.length) return null;
  return tabs.find((t) => t.audible) || tabs.find((t) => t.active) || tabs[0];
}

function showMessage(text) {
  $("player").hidden = true;
  $("msg").hidden = false;
  $("msg").textContent = text;
}

function render(state) {
  $("msg").hidden = true;
  $("player").hidden = false;

  // textContent only, never innerHTML
  $("title").textContent = state.title || "Nothing playing";
  $("artist").textContent = state.artist || "";
  $("toggle").textContent = state.playing ? "⏸" : "▶";
  $("vol").textContent = state.volume + "%";

  const art = $("art");
  if (state.artwork) {
    art.src = state.artwork;
    art.hidden = false;
  } else {
    art.hidden = true;
  }
}

async function send(message) {
  const tab = await findTab();
  if (!tab) {
    showMessage("Open music.youtube.com in a tab first.");
    return;
  }
  try {
    const res = await chrome.tabs.sendMessage(tab.id, message);
    if (res && res.ok && res.state) render(res.state);
  } catch (err) {
    showMessage("Can't reach the YT Music tab. Refresh it and try again.");
  }
}

document.querySelectorAll("button[data-cmd]").forEach((btn) => {
  btn.addEventListener("click", () => {
    send({ type: "COMMAND", command: btn.dataset.cmd });
  });
});

refreshPairing();
send({ type: "GET_STATE" });
setInterval(() => {
  refreshPairing();
  send({ type: "GET_STATE" });
}, 1000);
