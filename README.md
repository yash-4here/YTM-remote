**⬇️ Download the extension: [DRIVE-LINK](https://drive.google.com/file/d/1cyMoZ5dOcSPe1CeUvlwh4qD-tXtgQbn7/view?usp=drive_link)**

# YTM Remote

Control YouTube Music playing in Chrome on your laptop from your phone. It works like Spotify Connect, and your phone and laptop can be on different networks (cellular vs Wi-Fi). It is free, has no accounts, and uses no servers of mine.

**Phone page:** https://yash-4here.github.io/YTM-remote/

Features: play/pause, next/previous, volume slider, seekable progress bar, "Up next" queue with tap-to-jump, and QR-code pairing.

## Install (about 2 minutes)

1. Download the zip from the link above and **unzip** it. (Or click **Code → Download ZIP** on this repo and use the `docs` folder inside.)
2. Open `chrome://extensions` in Chrome and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the folder that contains `manifest.json`.
4. Open [music.youtube.com](https://music.youtube.com) and play something.
5. Click the extension icon. A **QR code** appears.
6. Scan it with your phone camera. The remote opens already paired.
7. Optional: on your phone, use "Add to Home Screen" to get an app-like icon.

If the scan doesn't work, open the phone page above and type the 12-character code from the extension popup.

## How it works

- The extension on your laptop and the phone page both connect to public MQTT message brokers over secure WebSockets.
- The pairing code is generated on your laptop. From it, both sides derive a private topic name and an encryption key (PBKDF2 → AES-GCM).
- Every message is encrypted, so the brokers only see scrambled data. Messages are also timestamped and de-duplicated to stop replays.
- Only a fixed list of commands is accepted (play, pause, next, previous, volume, seek, search, jump to a queue song). Each is validated and rate-limited.

## Privacy

- No account, no sign-in, no analytics, and nothing is sent to me.
- What travels (encrypted): the current song title, artist, position, volume, the queue, search list, and your commands.
- Your pairing code and settings are stored only in your own browser storage.
- Anyone with your pairing code can control your player. Use **New code** in the popup if you shared it by mistake.
- The extension only runs on `music.youtube.com`.

## Permissions

| Permission | Why |
|---|---|
| `storage` | Remember your pairing code |
| `alarms` | Keep the connection alive |
| `scripting` | Attach to YT Music tabs that were already open at install |
| Access to `music.youtube.com` | Read the playing song and press its controls |

## Known limits

- The laptop needs Chrome open with a YT Music tab (it can be in the background).
- Some strict networks block the public broker ports. If the phone can't connect, try another network.
- YT Music's page layout can change and break a feature. Please open an issue if that happens.
- Chrome shows a "developer mode extensions" notice because it isn't installed from the Web Store.

## Updating

Download the new zip, replace the old folder's contents, then click the reload icon on the extension in `chrome://extensions`.

## Repository layout

```
/ (root)   Phone web page, served by GitHub Pages
            index.html, remote.js, remote.css, carrier.js, sw.js,
            manifest.webmanifest, icon-192.png, icon-512.png
docs/      Chrome extension source (manifest, background, content scripts, popup)
```

`carrier.js` is shared by the phone page and the extension. Keep the two copies identical.

## Disclaimer

An unofficial project, not affiliated with or endorsed by YouTube or Google. "YouTube" and "YouTube Music" are trademarks of Google LLC.

## License

MIT. See [LICENSE](LICENSE).
