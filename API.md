# tabby-remote API (draft)

A Tabby plugin that serves the running Tabby's terminals to other devices. Your own app and the built-in phone page (QR) are both clients of this API.

## Status

| Part | State |
| --- | --- |
| QR pairing, password login, devices, sessions (list, open, change, close), groups, icons, profiles, files, attach, events | Built |
| Phone page at `/` | Built: sidebar like tabby-groups, terminal fitted to the screen, two-row key bar |
| Remote sign in Tabby | Built: device badges on tab rows in Tabby's sidebar (drawn by tabby-groups from `tab.__trPresence`, event `tabby-remote:presence`) and in the phone sidebar |
| Session ids kept across restarts | Not built: ids last until Tabby restarts |
| macOS and Linux | Supported, untested: plain Node, no native modules. A new tab opens Tabby's default profile; `run` without `command` uses `$SHELL` (Windows: `pwsh.exe` when installed, else `powershell.exe`). macOS asks once to allow incoming connections. |

## Settings

Set in Tabby's **Settings > Phone access**, and saved in `tabby-remote.json` in Tabby's user-data folder (`%APPDATA%\tabby`, `~/Library/Application Support/tabby`, `~/.config/tabby`).

| Key | Value |
| --- | --- |
| `enabled` | Phone access on or off (default on). Off: nothing listens and every device is disconnected; devices stay paired. |
| `name` | What clients call this computer (header, Home Screen icon). Default: the computer's host name. |
| `computerId` | Permanent random id of this Tabby, created on first start |
| `port` | Default `7681`. Applies after a Tabby restart. When taken (another Tabby on the same computer), the next free of the 10 after it is used and saved here. |
| `passwordHash` | The login password as a salted scrypt hash. Login is off while it is empty; QR pairing works without it. |
| `keepAwake`, `awakeMinutes` | Keep the PC awake while a device is attached, and this many minutes after the last one leaves (default on, 30) |
| `fsRoots` | Folders `/api/fs` may list. Default none. Only in the file. |
| `devices` | Paired devices (token hashes). Removed in Settings or with `DELETE /api/devices/:id`. A linked computer has `computer: true`. |
| `links` | The computers this one sends Claude chats to: `{ [computerId]: { token, deviceId, name } }`, its own device token on each. Unlink in Settings. |
| `announce` | Show this computer to the user's other computers (default on): a UDP broadcast every 30 s on port 41681 of the Wi-Fi network, `{ app: "tabby-remote", v: 1, computerId, name, port }`. Nothing secret. Every Tabby listens for the others' (see `/api/computers`). |

## Transport

| Item | Value |
| --- | --- |
| Server | HTTP + WebSocket on one port, inside Tabby's window process |
| Port | `7681` (setting). Not `7680`: Windows Delivery Optimization holds it on every PC. |
| Listen | Private (RFC 1918) and Tailscale (`100.64.0.0/10`) addresses only; never `0.0.0.0`. Checked every 30 s, so a new network or IP is picked up without a restart. |
| Away from home | Through Tailscale: `http://<computer>.<tailnet>.ts.net:<port>` or its `100.x` address; the API does not change |
| TLS | None: the LAN, or Tailscale, which encrypts the traffic itself |
| Format | JSON for REST and control messages; raw UTF-8 for terminal data |

## Auth

Every request needs `Authorization: Bearer <deviceToken>`. A WebSocket sends the token in its first message.

| Method | Flow |
| --- | --- |
| QR pairing | The QR button next to Tabby's Settings gear shows a QR code for `http://<lan-ip>:<port>/#pair=<code>` and the 6-digit code. The page (or your app) calls `POST /api/pair` with the code within 2 minutes and gets its own token. Tabby shows "<device> paired". |
| Password | Set in Settings > Phone access. `POST /api/login` with the password returns a device token. |

| Rule | Value |
| --- | --- |
| Device tokens | Random 256-bit, stored hashed, one per device, revocable in Tabby |
| Pairing code | Single use, 2-minute life |
| Failed logins | 5 per minute per address, then a 1-minute lockout |
| Host check | `Host` must be one of the server's own addresses, or this computer's Tailscale name `<hostname>.<tailnet>.ts.net`, with its port (stops DNS rebinding) |
| Origin check | `Origin`, when sent, must be this server, so only its own page can call it from a browser. Native apps send none. |

## REST

| Method | Path | Body / query | Returns |
| --- | --- | --- | --- |
| GET | `/api/info` | — | `{ tabby, plugin, host, id, name, port, password, groups }`: versions, host name, this computer's permanent `id`, display `name` and listening `port` (so a client that knows several computers can tell them apart, also at a new address), whether password login is on, whether tabby-groups is installed. No auth. |
| POST | `/api/pair` | `{ code, deviceName, computer? }` | `{ token, deviceId }`. `computer: true`: another of the user's computers linking (Send to computer). |
| POST | `/api/login` | `{ password, deviceName, computer? }` | `{ token, deviceId }`; `computer` as for `/api/pair` |
| GET | `/api/devices` | — | `[{ id, name, created, current }]` |
| GET | `/api/computers` | — | The other computers running tabby-remote on this network, heard in the last 2 minutes: `[{ computerId, name, url, linked }]`. `url` is the address its announcement came from, so a changed IP is followed. Signing in there needs its own code or password. `linked`: this computer can send Claude chats there. |
| POST | `/api/pairing` | — | A single-use, 2-minute pairing code for another device, made by a signed-in one: `{ code, url, expires, svg }` (`svg` is its QR) |
| DELETE | `/api/devices/:id` | — | Revokes one device and closes its sockets (code `4001`) |
| GET | `/api/sessions` | — | Tabs (see Session) |
| GET | `/api/groups` | — | tabby-groups `list()`: `[{ name, color, collapsed, pinned, parent, tabs, needsYou, busy }]`; `needsYou`/`busy` count Claude tabs in the whole subtree |
| POST | `/api/upload` | Raw file body; header `X-Filename` (URI-encoded). Max 50 MB. | `{ path }`: saved in `<temp>/tabby-remote/uploads`. Paste the path into a terminal to hand the file over (Claude Code attaches an image by its path). |
| GET | `/api/clipboard` | — | The PC's clipboard: `{ text, path: null }`, or for an image `{ text: null, path }` (saved as PNG in the uploads folder) |
| PUT | `/api/clipboard` | `{ text }` | Puts the text on the PC's clipboard |
| GET | `/api/sessions/:id/peek` | `?lines=` (1–60, default 12) | `{ lines }`: the last lines on the tab's screen, without attaching |
| PATCH | `/api/groups/:name` | `{ color?, collapsed?, pinned?, parent?, name? }` (`color`/`parent` may be `null`) | The group. Applied by tabby-groups; `409` when a rename or move is refused. |
| POST | `/api/groups/:name/ungroup` | — | Dissolves one level, as tabby-groups' menu does |
| GET | `/api/icons` | — | tabby-groups icons by kind: `{ label, color, path or paths, stroke? }`, 24×24 |
| POST | `/api/sessions` | `{ profile?, command?, args?, cwd?, run?, title?, group?, parent? }` | The new Session. Uses `__tabbyGroups.open` when tabby-groups is installed. |
| POST | `/api/move` | `{ source, target, where }`: `source`/`target` are `{ session: id }` or `{ group: name }`; `where` is `before`/`after`/`onto` on a tab, `above`/`first`/`last`/`below` on a group | Drag and drop, applied by tabby-groups' own rules (`__tabbyGroups.drop`). `409` when not allowed there, `501` without tabby-groups. |
| PATCH | `/api/sessions/:id` | `{ title?, group?, parent?, pinned?, focus? }` | The updated Session. `group` is a group name (created, under `parent`, if new), or `null` to ungroup. An empty `title` clears the custom title. `pinned` pins inside the group, or with Tabby's pin when loose. |
| DELETE | `/api/sessions/:id` | — | Closes the tab without asking. `409` when it is pinned. |
| GET | `/api/profiles` | — | `[{ id, name, type, icon }]`; `icon` may be SVG markup |
| POST | `/api/sessions/:id/send` | `{ computerId }` | Send to computer: this computer exports the tab's Claude chat (claude-sessions) and sends it to that linked computer, which opens it in a new tab. `{ ok, name, cwd, warnings }`, or `409 { error }`. |
| POST | `/api/import` | A claude-sessions export zip (max 200 MB) | From a linked computer only (`403` otherwise). The zip is checked (only `meta.json`, `<id>.jsonl`, `<id>/…`; no absolute or `..` paths), imported by claude-sessions, and opened in a new tab running `claude --resume <id>` in the folder the import chose. `{ ok, cwd, warnings }`; `409` when there is no clone or it was imported before; `501` without claude-sessions. |
| GET | `/api/fs` | `?path=` | Folder entries `{ name, type: 'dir'|'file', size, mtime }`. No `path` lists the roots. `403` outside them. |

Errors are `{ "error": "<text>" }` with `400`, `401`, `403`, `404`, `409`, `429` or `500`.

### Session

```json
{
  "id": "b7c1…",            // lasts until Tabby restarts
  "title": "api-server",
  "kind": "claude",         // the tabby-groups icon kind: claude, codex, pwsh, cmd, bash, …
  "cwd": "C:\\projects\\app",
  "group": ["work", "api-server"],   // group path, root first; [] when ungrouped
  "index": 3,               // 1-based position in Tabby's tab list
  "pinned": false,
  "active": true,           // the tab selected in Tabby
  "remote": ["iPhone"],          // devices attached now (names only; see viewers)
  "viewers": [                            // one per device attached to any pane; badges in both sidebars
    { "id": "6001…", "name": "iPhone", "color": "#4fc3f7", "state": "typing", "sizer": true }
  ],                                      // state: typing (keys in the last 4 s) | watching | away (page in the background); sizer: the terminal is at its size
  "agent": { "state": "waiting", "since": 1792030025047, "needsYou": true },   // Claude tabs only (from tabby-groups), else null. needsYou: finished while nobody looked; cleared when a device opens the tab
  "layout": { "split": "h", "ratios": [0.5, 0.5], "children": ["p1", "p2"] },   // Tabby's split tree; a single pane is just "p1"
  "panes": [
    { "id": "p1", "kind": "claude", "cwd": "C:\\projects\\app", "focused": true, "size": { "cols": 120, "rows": 40 } },
    { "id": "p2", "kind": "pwsh", "cwd": "C:\\projects\\app", "focused": false, "size": { "cols": 80, "rows": 40 } }
  ]
}
```

A tab with split panes is one Session. Each pane is attached on its own (see Attach), so a client chooses how to show them:

| Client | Panes |
| --- | --- |
| Phone | One pane at a time with a pane switcher, or all panes stacked vertically |
| Laptop or tablet | The `layout` tree, as Tabby shows it |

## WebSocket

| Path | Use |
| --- | --- |
| `/api/sessions/:id/panes/:pane/attach` | One pane: output, input, size |
| `/api/events` | Changes to the tab list |

### Attach

| Direction | Message |
| --- | --- |
| Client → server | `{ "type": "auth", "token" }` (first message, within 5 s; else closed with `4001`) |
| Server → client | `{ "type": "snapshot", "cols", "rows", "data" }`: the screen and the scroll history, serialized, so the client continues where Tabby is |
| Server → client | Binary frames: terminal output, in order |
| Client → server | `{ "type": "input", "data" }`: keys, as the terminal would send them |
| Client → server | `{ "type": "resize", "cols", "rows" }` |
| Client → server | `{ "type": "presence", "state": "away" \| "here" }` when the client goes to the background or comes back |
| Server → client | `{ "type": "size", "cols", "rows" }` when the terminal size changes (see Size rule) |
| Server → client | `{ "type": "exit" }` when the tab closes |

| Close code | Meaning |
| --- | --- |
| `4001` | Bad or revoked token |
| `4004` | No such session or pane |
| `1011` | The pane's terminal did not start |

A client must not answer the shell's queries (cursor position, device attributes, focus, colours). Tabby's own terminal answers them; a second answer arrives as typed input. With xterm.js, swallow CSI `n`, CSI `c`, CSI `>c`, `?1004h`, and OSC 10–12 `?`.

Attaching to a background tab that has not started yet selects it in Tabby, because Tabby starts a restored tab's shell only when it is shown.

### Size rule

| Event | Terminal size |
| --- | --- |
| A remote client sends input or `resize` | The terminal takes the remote size. Apps such as Claude redraw for it. |
| You type in Tabby again | The terminal returns to Tabby's size. |
| Several remote clients | The last one that typed sets the size. |
| The client setting the size goes to the background (`presence` `away`) or leaves | The size passes to the latest other client still looking at the pane, else back to Tabby. |
| It comes back (`presence` `here`) | It takes the size again, unless another client holds it now. |
| A client goes silent | The server pings every 15 s and drops a connection it has not heard from for 45 s, so a phone that lost Wi-Fi or was killed lets go of the size. |
| Phone page | Fits the terminal to its screen as soon as a tab opens, and again on rotation or when the keyboard opens |
| Input right after a resize | Held 200 ms, so PowerShell does not drop the first key while it redraws |

### Events

| Message | When |
| --- | --- |
| `{ "type": "opened", "session" }` | A tab opens |
| `{ "type": "closed", "id" }` | A tab closes |
| `{ "type": "changed", "session" }` | Any field of the Session changes: title, icon, folder, group, focus, size, `remote` |
| `{ "type": "groups", "groups" }` | Groups change (the tabby-groups `list()` shape) |

Same `auth` first message as Attach. Load `GET /api/sessions` first, then apply events. Changes are checked each second and on Tabby's tab events.

## Files (for the iOS catalog)

| Rule | Value |
| --- | --- |
| Allowed roots | `fsRoots` in the settings, for example `C:\projects`, `D:\code`. Default: none, so files are off until set. |
| Paths | Resolved and checked against the roots, so `..` and links cannot leave them |
| Writes | None in v1 |
| Shell in a folder | `POST /api/sessions` with `cwd` |

## Remote sign in Tabby

| Where | Sign |
| --- | --- |
| Tab row | A small "remote" badge while any device is attached to one of its panes |
| Sidebar top row | A count of connected devices; a click lists them, with "Disconnect" and "Revoke" |
| On connect | A short notice in Tabby: "<device> connected" |

## Decisions

| # | Decision |
| --- | --- |
| 1 | Port `7681` (was `7680`; taken by Windows) — to confirm |
| 2 | A tab with split panes is one Session; panes attach separately (see Session) |
| 3 | Tabby shows a sign while a device is attached (see Remote sign) |
