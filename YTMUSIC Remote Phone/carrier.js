(function (root) {
  "use strict";
 
  const BROKERS = [
    "wss://broker.emqx.io:8084/mqtt",
    "wss://broker.hivemq.com:8884/mqtt",
  ];

  const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const CODE_LENGTH = 12;

  const PBKDF2_ITERATIONS = 100000;
  const MAX_AGE_MS = 5 * 60 * 1000;
  const MAX_PAYLOAD = 8192;
  const KEEPALIVE_S = 60;
  const PING_MS = 15000; 
  const DEAD_MS = 40000; 
  const CONNECT_TIMEOUT_MS = 10000;
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function generateCode() {
    const bytes = root.crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
    let code = "";
    for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[bytes[i] & 31];
    return code;
  }

  function normalizeCode(input) {
    if (typeof input !== "string") return null;
    const code = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (code.length !== CODE_LENGTH) return null;
    for (let i = 0; i < code.length; i++) {
      if (ALPHABET.indexOf(code[i]) === -1) return null;
    }
    return code;
  }

  function formatCode(code) {
    return typeof code === "string" && code ? code.match(/.{1,4}/g).join("-") : "";
  }

  function hex(bytes) {
    let out = "";
    for (let i = 0; i < bytes.length; i++) out += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16);
    return out;
  }

  function randomId() {
    return hex(root.crypto.getRandomValues(new Uint8Array(8)));
  }

  function concat(a, b) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }

  async function topicBase(code) {
    const clean = normalizeCode(code);
    if (!clean) throw new Error("bad pairing code");
    if (!root.crypto || !root.crypto.subtle) throw new Error("needs a secure (https) page");

    const material = await root.crypto.subtle.importKey("raw", enc.encode(clean), "PBKDF2", false, ["deriveBits"]);
    const bits = await root.crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: enc.encode("ytmr/v1"), iterations: PBKDF2_ITERATIONS },
      material,
      384
    );
    const bytes = new Uint8Array(bits);
    const key = await root.crypto.subtle.importKey("raw", bytes.slice(16, 48), "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]);
    return { topic: "ytmr/" + hex(bytes.slice(0, 16)), key: key };
  }

  async function seal(base, direction, msg) {
    const iv = root.crypto.getRandomValues(new Uint8Array(12));
    const plain = enc.encode(JSON.stringify({ i: randomId(), t: Date.now(), m: msg }));
    const cipher = new Uint8Array(
      await root.crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv, additionalData: enc.encode(direction) },
        base.key,
        plain
      )
    );
    return concat(iv, cipher);
  }

  async function open(base, direction, payload) {
    const iv = payload.slice(0, 12);
    const cipher = payload.slice(12);
    const plain = await root.crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv, additionalData: enc.encode(direction) },
      base.key,
      cipher
    );
    return JSON.parse(dec.decode(plain));
  }

  const PINGREQ = Uint8Array.of(0xc0, 0x00);
  const DISCONNECT = Uint8Array.of(0xe0, 0x00);

  function mqttString(s) {
    const b = enc.encode(s);
    return concat(Uint8Array.of(b.length >> 8, b.length & 255), b);
  }

  function mqttPacket(header, body) {
    const len = [];
    let n = body.length;
    do {
      let digit = n % 128;
      n = Math.floor(n / 128);
      if (n > 0) digit |= 128;
      len.push(digit);
    } while (n > 0);
    const out = new Uint8Array(1 + len.length + body.length);
    out[0] = header;
    out.set(len, 1);
    out.set(body, 1 + len.length);
    return out;
  }

  function connectPacket() {
    const clientId = "ytmr-" + randomId();
    const head = concat(mqttString("MQTT"), Uint8Array.of(4, 0x02, KEEPALIVE_S >> 8, KEEPALIVE_S & 255));
    return mqttPacket(0x10, concat(head, mqttString(clientId)));
  }

  function subscribePacket(topic) {
    const body = concat(Uint8Array.of(0, 1), concat(mqttString(topic), Uint8Array.of(0)));
    return mqttPacket(0x82, body);
  }

  function publishPacket(topic, payload) {
    return mqttPacket(0x30, concat(mqttString(topic), payload));
  }

  function createLink(options) {
    const role = options.role === "laptop" ? "laptop" : "phone";
    const base = options.base;
    const sendDir = role === "phone" ? "p" : "l";
    const recvDir = role === "phone" ? "l" : "p";
    const pubTopic = base.topic + "/" + sendDir;
    const subTopic = base.topic + "/" + recvDir;
    const urls = options.brokers && options.brokers.length ? options.brokers : BROKERS;
    const conns = urls.map(function (url) {
      return { url: url, ws: null, ready: false, buf: new Uint8Array(0), attempts: 0, retry: null, ping: null, guard: null, lastRx: 0 };
    });

    const seen = new Map(); 
    let closed = false;
    let lastCount = 0;

    function count() {
      let n = 0;
      for (const c of conns) if (c.ready) n++;
      return n;
    }

    function status() {
      return { connected: count(), total: conns.length };
    }

    function emit() {
      const connected = count();
      if (connected === lastCount) return;
      const wasZero = lastCount === 0;
      lastCount = connected;
      if (options.onStatus) options.onStatus({ connected: connected, total: conns.length });
      if (wasZero && connected > 0 && options.onConnect) options.onConnect();
    }

    function write(c, bytes) {
      if (!c.ws || c.ws.readyState !== 1) return;
      try {
        c.ws.send(bytes);
      } catch (e) {
        drop(c);
      }
    }

    function scheduleRetry(c) {
      if (closed || c.retry) return;
      c.attempts++;
      const wait = Math.min(30000, 1000 * Math.pow(2, Math.min(c.attempts, 5)));
      c.retry = setTimeout(function () {
        c.retry = null;
        connect(c);
      }, wait * (0.7 + Math.random() * 0.6));
    }

    function drop(c) {
      clearTimeout(c.guard);
      clearInterval(c.ping);
      c.guard = null;
      c.ping = null;
      const ws = c.ws;
      c.ws = null;
      c.ready = false;
      if (ws) {
        ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
        try {
          ws.close();
        } catch (e) {
        }
      }
      emit();
      scheduleRetry(c);
    }

    function markReady(c) {
      if (c.ready) return;
      c.ready = true;
      c.attempts = 0;
      clearTimeout(c.guard);
      c.guard = null;
      c.ping = setInterval(function () {
        if (Date.now() - c.lastRx > DEAD_MS) drop(c);
        else write(c, PINGREQ);
      }, PING_MS);
      emit();
    }

    function connect(c) {
      if (closed || c.ws) return;
      clearTimeout(c.retry);
      c.retry = null;

      let ws;
      try {
        ws = new WebSocket(c.url, "mqtt");
      } catch (e) {
        scheduleRetry(c);
        return;
      }
      ws.binaryType = "arraybuffer";
      c.ws = ws;
      c.ready = false;
      c.buf = new Uint8Array(0);
      c.lastRx = Date.now();
      c.guard = setTimeout(function () {
        if (c.ws === ws && !c.ready) drop(c);
      }, CONNECT_TIMEOUT_MS);

      ws.onopen = function () {
        if (c.ws === ws) write(c, connectPacket());
      };
      ws.onmessage = function (event) {
        if (c.ws !== ws || !(event.data instanceof ArrayBuffer)) return;
        c.lastRx = Date.now();
        feed(c, new Uint8Array(event.data));
      };
      ws.onclose = ws.onerror = function () {
        if (c.ws === ws) drop(c);
      };
    }

    function feed(c, chunk) {
      c.buf = concat(c.buf, chunk);
      while (c.ws && c.buf.length >= 2) {
        let multiplier = 1;
        let length = 0;
        let i = 1;
        let digit;
        do {
          if (i >= c.buf.length) return; 
          digit = c.buf[i++];
          length += (digit & 127) * multiplier;
          multiplier *= 128;
          if (multiplier > 128 * 128 * 128 * 128) return drop(c);
        } while (digit & 128);
        if (length > 65536) return drop(c);
        if (c.buf.length < i + length) return; 

        const header = c.buf[0];
        const body = c.buf.slice(i, i + length);
        c.buf = c.buf.slice(i + length);
        handle(c, header, body);
      }
    }

    function handle(c, header, body) {
      const type = header >> 4;
      if (type === 2) {
        if (body[1] === 0) write(c, subscribePacket(subTopic));
        else drop(c);
      } else if (type === 9) {
        if (body.length >= 3 && body[2] !== 0x80) markReady(c);
        else drop(c);
      } else if (type === 3) {
        const qos = (header >> 1) & 3;
        if (body.length < 2) return;
        const topicLength = (body[0] << 8) | body[1];
        let offset = 2 + topicLength;
        if (body.length < offset) return;
        const topic = dec.decode(body.slice(2, offset));
        if (qos > 0) {
          if (body.length < offset + 2) return;
          if (qos === 1) write(c, Uint8Array.of(0x40, 0x02, body[offset], body[offset + 1]));
          offset += 2;
        }
        if (topic === subTopic) receive(body.slice(offset));
      }
    }

    function remember(id) {
      seen.set(id, Date.now());
      if (seen.size > 400) {
        const cutoff = Date.now() - MAX_AGE_MS;
        for (const entry of seen) {
          if (entry[1] < cutoff) seen.delete(entry[0]);
        }
        while (seen.size > 400) seen.delete(seen.keys().next().value);
      }
    }

    async function receive(payload) {
      if (payload.length < 29 || payload.length > MAX_PAYLOAD) return;
      let envelope;
      try {
        envelope = await open(base, recvDir, payload);
      } catch (e) {
        return; 
      }
      if (!envelope || typeof envelope.i !== "string" || typeof envelope.t !== "number") return;
      if (Math.abs(Date.now() - envelope.t) > MAX_AGE_MS) return;
      if (seen.has(envelope.i)) return;
      remember(envelope.i);

      const msg = envelope.m;
      if (!msg || typeof msg !== "object" || Array.isArray(msg) || typeof msg.type !== "string") return;
      try {
        if (options.onMessage) options.onMessage(msg);
      } catch (e) {
      }
    }

    async function send(msg) {
      if (closed) return false;
      try {
        const payload = await seal(base, sendDir, msg);
        if (payload.length > MAX_PAYLOAD) return false;
        const packet = publishPacket(pubTopic, payload);
        let sent = 0;
        for (const c of conns) {
          if (c.ready) {
            write(c, packet);
            sent++;
          }
        }
        return sent > 0;
      } catch (e) {
        return false;
      }
    }

    function nudge() {
      if (closed) return;
      for (const c of conns) {
        if (!c.ws) {
          clearTimeout(c.retry);
          c.retry = null;
          c.attempts = 0;
          connect(c);
        } else if (c.ready) {
          const ws = c.ws;
          const before = c.lastRx;
          write(c, PINGREQ);
          setTimeout(function () {
            if (c.ws === ws && c.lastRx === before) drop(c);
          }, 4000);
        }
      }
    }

    function close() {
      closed = true;
      for (const c of conns) {
        clearTimeout(c.retry);
        clearTimeout(c.guard);
        clearInterval(c.ping);
        const ws = c.ws;
        c.ws = null;
        c.ready = false;
        if (ws) {
          ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
          try {
            if (ws.readyState === 1) ws.send(DISCONNECT);
            ws.close();
          } catch (e) {
          }
        }
      }
    }

    conns.forEach(connect);
    return { send: send, nudge: nudge, close: close, status: status };
  }

  root.Carrier = {
    BROKERS: BROKERS,
    generateCode: generateCode,
    normalizeCode: normalizeCode,
    formatCode: formatCode,
    topicBase: topicBase,
    createLink: createLink,
  };
})(typeof self !== "undefined" ? self : globalThis);
