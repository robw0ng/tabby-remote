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
| Files | Upload photos and files to the PC; paste from the PC's clipboard |
| Search | Search the terminal, as in Tabby (Ctrl+Shift+F) |
| Several devices | Each device has a colour; Tabby shows who is watching or typing in which tab |
| Keeps the PC awake | While a device has a tab open (can be turned off) |
| Add to Home Screen | Opens full screen like an app |

## Install

Needs Tabby 1.0. For an agent-run install on Windows (safe to rerun, with a check at the end), see [INSTALL.md](INSTALL.md).

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

Tabby **Settings > Phone access**:

| Setting | Default |
| --- | --- |
| Port | `7681` |
| Password sign-in | Off (QR only) |
| Keep this PC awake | On, and 30 minutes after the last device leaves |
| Paired devices | Remove one to sign it out |

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
