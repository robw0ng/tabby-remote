# tabby-remote

Use your [Tabby](https://tabby.sh) terminals from your phone, tablet or another computer on the same Wi-Fi. Scan a QR code and the page opens with your tabs and a terminal made for touch.

It is also an HTTP + WebSocket API, so you can build your own client. See [API.md](API.md).

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

## Security

| Point | Detail |
| --- | --- |
| Network | Listens on your local network only, over plain HTTP. Use it on networks you trust. |
| Devices | Each device has its own token, stored hashed. Remove a device in Settings to sign it out. |
| Pairing codes | Single use, valid 2 minutes |
| Password | Stored as a salted hash. 5 wrong tries lock that address for a minute. |
| Other sites | Requests from other web pages are refused |

Anyone who signs in can type into your terminals. Only pair devices you own.

## License

All rights reserved.
