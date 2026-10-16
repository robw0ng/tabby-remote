# Install the tabby-remote plugin (for an agent)

You were given a zip holding this file, README.md and a `tabby-remote` folder. Install that folder into Tabby. Every step is safe to run again.

Rules: no admin rights; touch nothing outside Tabby's plugins folder; never kill Tabby's process (it loses the user's open tabs).

## 1. Find Tabby's plugins folder

| System | Plugins folder |
| --- | --- |
| Windows | `%APPDATA%\tabby\plugins\node_modules` |
| macOS | `~/Library/Application Support/tabby/plugins/node_modules` |

```powershell
# Windows (PowerShell)
$tabby = "$env:APPDATA\tabby"
Test-Path $tabby
```

```sh
# macOS
tabby="$HOME/Library/Application Support/tabby"
test -d "$tabby" && echo found
```

Tabby's data folder (`tabby`) is missing → Tabby is not installed, or has never been started: stop and tell the user. Inside it, create `plugins/node_modules` if it is missing.

## 2. An earlier install

Look for `tabby-remote` in the plugins folder. When it is there, compare its `package.json` `version` with the one in this zip's `tabby-remote/package.json`, tell the user both, and ask before replacing it. Leave it alone if they say no.

## 3. Copy the plugin in

Copy the whole `tabby-remote` folder from the zip into the plugins folder: its `node_modules` is included, so no `npm install`. When replacing, delete the old `tabby-remote` folder first, after the user agreed in step 2.

```powershell
# Windows
$plugins = "$tabby\plugins\node_modules"
New-Item -ItemType Directory -Force $plugins | Out-Null
Copy-Item -Recurse -Force '<unzipped folder>\tabby-remote' $plugins
Test-Path "$plugins\tabby-remote\index.js"
```

```sh
# macOS
plugins="$tabby/plugins/node_modules"
mkdir -p "$plugins"
cp -R "<unzipped folder>/tabby-remote" "$plugins/"
test -f "$plugins/tabby-remote/index.js" && echo copied
```

The result must be `.../node_modules/tabby-remote/index.js`, not `tabby-remote` inside another `tabby-remote`.

## 4. Restart Tabby

Ask the user to quit Tabby (macOS: Cmd+Q) and open it again. Tabby loads plugins only at startup.

Before that, tell the user what may happen: on the first start, Windows (or the macOS firewall, when on) may ask whether Tabby can accept connections. That is the plugin's port 7681, so a phone on the same Wi-Fi can reach Tabby; only paired devices can use it. Allowing it on private networks makes phone access work; denying it keeps phone access off this network. Let the user choose.

## 5. Verify

```powershell
# Windows
Invoke-RestMethod http://127.0.0.1:7681/api/info
```

```sh
# macOS
curl -s http://127.0.0.1:7681/api/info
```

Expect `{ tabby, plugin, host, id, name, port, password, groups }`; `plugin` is the version installed. `"password": false` only means password sign-in is not set up; it does not open anything: a device still needs the single-use code from the QR (or a password, once one is set) to get in.

| Result | Meaning |
| --- | --- |
| Answers | Installed and running |
| Refused | Tabby was not restarted, phone access is turned off in Settings > Phone access, or the port was changed there |
| Another app answers | Something else holds port 7681: pick another port in Settings > Phone access and restart Tabby |

## 6. Report to the user

| Tell them | Detail |
| --- | --- |
| Installed | The version (`plugin` from step 5) |
| Pair a phone | Click the QR button in Tabby's toolbar and scan it with the phone's camera, on the same Wi-Fi. On an iPhone, Share > Add to Home Screen opens it like an app. |
| Turn it off | Tabby Settings > Phone access: switch Phone access off. Paired devices stay paired. |
| Uninstall | Quit Tabby, delete the `tabby-remote` folder from the plugins folder, start Tabby |
