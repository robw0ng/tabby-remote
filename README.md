# tabby-remote

Use your [Tabby](https://tabby.sh) terminals from your phone, tablet or another computer on the same Wi-Fi. Scan a QR code and the page opens with your tabs and a terminal made for touch.

It is also an HTTP + WebSocket API, so you can build your own client. See [API.md](API.md).

<!-- Screenshot: the phone page with the tab sidebar and a terminal (docs/phone.png, to add). -->

## What you get

| Feature | Detail |
| --- | --- |
| Pair by QR | The QR button in Tabby's toolbar shows a code. Scan it and the device stays signed in. |
| Tab sidebar | Every tab, with groups, pins, drag and drop, swipe to close, search |
| Terminal for touch | Fits the screen, native scrolling, pinch to zoom, tap to move the cursor, double and triple tap to select |
| Key bar | Esc, Tab, Shift, Ctrl, Alt, ^C, arrows, Home, End, PgUp, PgDn, Copy, Paste |
| Claude Code | Its questions show as buttons; a tab that needs you shows in the sidebar |
| Files | Upload photos and files to the PC; paste from the PC's clipboard; 📁 browses the PC's Shared folders |
| Search | Search the terminal, as in Tabby (Ctrl+Shift+F) |
| Several devices | Each device has a colour; Tabby shows who is watching or typing in which tab |
| Keeps the PC awake | While a device has a tab open (can be turned off) |
| Add to Home Screen | Opens full screen like an app |

## Install

Needs Tabby 1.0. For an agent-run install on Windows or macOS (safe to rerun, with a check at the end), see [INSTALL.md](INSTALL.md).

1. Close Tabby.
2. In Tabby's plugin folder, install the plugin and its dependencies:

   | System | Plugin folder |
   | --- | --- |
   | Windows | `%APPDATA%\tabby\plugins` |
   | macOS | `~/Library/Application Support/tabby/plugins` |
   | Linux | `~/.config/tabby/plugins` |

   ```sh
   cd <plugin folder>
   npm install <path or git URL of this repo>
   ```

3. Start Tabby. Allow incoming connections if Windows or macOS asks.
4. Click the QR button in Tabby's toolbar and scan it with your phone.

## Settings

Tabby **Settings > Devices**:

| Setting | Default |
| --- | --- |
| Allow connections | On. Off stops listening on the network and drops phones and linked computers; they stay paired. |
| Computer name | The computer's own name. Shown in the phone's header and as its Home Screen icon's name, so each computer gets its own icon. |
| Port | `7681`, or the next free one when another Tabby on the computer has it |
| Password sign-in | Off (QR only) |
| Paired phones and browsers | Remove one to sign it out |
| Your computers | Link once, from either computer: both can reach each other (see below) |
| Show this computer on my network | On: your other computers find this one |
| Shared folders | None |
| Keep this computer awake | On, and 30 minutes after the last device leaves |

## Reloading without restarting Tabby

After an update on disk, run this in Tabby's DevTools console (or from another plugin) to swap in the new code. The servers close, the new ones start on the same port, paired devices stay paired and connected phones reconnect by themselves:

```js
window.__tabbyRemote.reload()
```

To load the plugin from a fresh path instead, clear its files from `require.cache` and call `require('<plugin folder>/index.js').install(injector)`; `install` disposes the running instance first. `window.__tabbyRemote.dispose()` alone stops it and resolves once the port is free.

## Away from home

Install [Tailscale](https://tailscale.com) on the phone and the computer, and turn on MagicDNS. Then click the QR button in Tabby, switch it to **Tailscale**, and scan: the code links to the computer's Tailscale name (`http://<computer>.<tailnet>.ts.net:7681`, from the Tailscale CLI, or its `100.x` address without the CLI). Use that link at home too, with Tailscale left on: the phone keeps one sign-in and one Home Screen icon for it everywhere. A new network or IP is picked up within 30 seconds.

## Send to computer

Moves a Claude chat to another of your computers on the same network, which opens it in a new tab and resumes it: right-click a Claude tab › **Send to computer**, or long-press it on the phone. Link the two computers once, from either one, in Settings › Devices › Your computers, with the code from the other's QR button (or its password): the other links back by itself, so both reach each other. Unlinking on either one unlinks both. Compact a big chat and push its branch first: the other computer opens it in its own clone of the repo.

Needs the [claude-sessions](https://github.com/robw0ng/claude-sessions) plugin and Node.js on both computers; without them the menu item stays hidden.

## Talk between computers

The Claude chats on two linked computers can message each other: a chat here types a message into a Claude tab there, which answers the same way, so they can compare their environments, hand each other steps and work on one task together. With [tabby-groups](https://github.com/robw0ng/tabby-groups): `node tab-say.mjs "<tab there>" "<message>" --computer <name>` (`--computer <name>` alone lists its Claude tabs). A message arrives as `[from <computer> · "<tab>"] …` with the reply command; only Claude tabs take one, never a shell, and Tabby shows a notice for each. Needs tabby-groups 0.1.5 or later on both computers.

## Files between computers

Linked computers also use each other's **Shared folders** (Settings › Devices › Shared folders): browse, copy, move and delete files there, for example from the Files tab of [tabby-files](https://github.com/robw0ng/tabby-files). Nothing is shared until you add a folder. Phones and browsers get the 📁 button on the page: browse, preview, download, upload new files, and paste a path into the terminal; moving, overwriting and deleting stay with linked computers. Nothing outside those folders is reachable, through `..` or links; deleted files go to the Recycle Bin / Trash. Big files stream with no size limit. Both computers need this version: each checks the other is really the computer it linked to before using it. When linking, check the fingerprint Tabby shows matches the one in the other computer's Settings › Devices › This computer (or under its QR): if it doesn't, something else on the network is answering, and nothing is sent.

## Works with tabby-groups

With [tabby-groups](https://github.com/robw0ng/tabby-groups) installed, the phone sidebar shows the same groups, colours and pins, and changes sync both ways. Without it, the sidebar lists plain tabs.

## How it works

The plugin runs inside Tabby's window. `index.js` builds one shared context and loads each part from `lib/`, which adds its functions to it:

| Part | Files |
| --- | --- |
| Server | `server.js` (HTTP and WebSocket on private and Tailscale addresses), `routes.js` (the API), `ws.js` (WebSocket framing) |
| Signing in | `pairing.js` (QR codes), `devices.js` (tokens, lockout), `secrets.js`, `store.js` (settings file) |
| Terminals | `sessions.js`, `attach.js` (a pane's screen and input), `size.js`, `presence.js`, `events.js`, `theme.js` |
| Computers | `discovery.js` (finding them), `identity.js` (keys, sealed linking, checking a linked computer is really it), `move.js` (linking, Send to computer), `talk.js`, `share.js` (Shared folders), `tailscale.js`, `net.js` |
| Tabby | `settings.js` (Settings › Devices), `power.js` (keep awake), `uploads.js` (uploads, clipboard), `model.js` |

`web/` is the page: plain scripts with no build step, loaded in the order `index.html` lists. Tests: `npm test`.

## Security

A signed-in device can do anything you can do in a terminal. Only pair devices you own, on networks you trust.

| Point | Detail |
| --- | --- |
| Network | Plain HTTP on private (home, office) addresses and Tailscale; never on all interfaces. On Wi-Fi, anyone who can watch the traffic can read what a phone sends: its password at sign-in, its token, and the terminal itself. Tailscale encrypts all of it. Anyone on your tailnet can reach the port. |
| Devices | Each device has its own random 256-bit token, stored hashed on the computer. Remove a device in Settings to sign it out at once. A signed-in device can also pair another one and remove devices. |
| Pairing codes | 6 digits, valid 2 minutes, for one pairing (a phone that loads the link twice gets 30 s more). 10 wrong codes in all and it stops working (Tabby's QR shows a new one). |
| Password | Optional, stored as a salted scrypt hash. 5 wrong tries (passwords or codes) lock that address for a minute. |
| Other sites | Requests from other web pages are refused (Host and Origin checks), so a page you visit cannot reach it. |
| Computers | Linking two computers gives each full access to the other (terminals, Shared folders, messages to Claude tabs). Before linking, each proves its identity (keys, a fingerprint you compare) and the password or code goes sealed, so a device pretending to be one of yours learns nothing usable. Links made before identities existed are checked with a weaker proof until they are next used. |
| On this computer | Settings, linked computers' tokens and this computer's private keys are kept in `tabby-remote.json` in Tabby's data folder, readable only by you. |
| Without sign-in | `/api/info` (name, version, Tailscale name), `/api/identity` and `/api/prove` (public keys and proofs), `/api/qr` (shows the QR on this screen, at most every 10 s per address), and 30-minute signed download links for files dragged out of the page. |

The code is open, and nothing depends on it staying secret: every code, token, id and key comes from the system's random generator. See [API.md](API.md) for the protocol.

## License

MIT, see [LICENSE](LICENSE).
