# Install (for an agent)

Steps an agent can follow when asked to "install https://github.com/robw0ng/tabby-remote". Every step is safe to run again.

| System | Shell | State |
| --- | --- | --- |
| Windows | PowerShell | Tested |
| macOS | zsh | Untested on a real Mac. The plugin uses no Windows-only code: uploads go to the system temp folder; clipboard and keep-awake use Electron. |

## 0. Check

| Need | Windows | macOS | If missing |
| --- | --- | --- | --- |
| Tabby 1.0 | `Test-Path "$env:LOCALAPPDATA\Programs\Tabby\Tabby.exe"` | `test -d /Applications/Tabby.app` | Ask the user to install Tabby from https://tabby.sh |
| Node.js and npm | `npm -v` | `npm -v` | Ask the user to install Node.js LTS |
| Git, with access to the repo (it is private) | `git ls-remote https://github.com/robw0ng/tabby-remote` | same | Ask the user to sign in (`gh auth login`) |

## 1. Clone, or update

Windows:

```powershell
$repo = 'C:\tabby-remote'
if (Test-Path "$repo\.git") { git -C $repo pull --ff-only } else { git clone https://github.com/robw0ng/tabby-remote $repo }
```

macOS:

```sh
repo="$HOME/tabby-remote"
if [ -d "$repo/.git" ]; then git -C "$repo" pull --ff-only; else git clone https://github.com/robw0ng/tabby-remote "$repo"; fi
```

Use another folder if the user prefers; keep it in `$repo`.

## 2. Dependencies

Windows:

```powershell
npm --prefix $repo ci --omit=dev
```

macOS:

```sh
npm --prefix "$repo" ci --omit=dev
```

## 3. Put it where Tabby loads plugins

Tabby loads each folder in `plugins/node_modules` inside its data folder. A link to the clone means a later update is just step 1 plus a Tabby restart.

| System | Plugin folder | Link |
| --- | --- | --- |
| Windows | `%APPDATA%\tabby\plugins\node_modules` | Junction |
| macOS | `~/Library/Application Support/tabby/plugins/node_modules` | Symlink |

Windows:

```powershell
$plugins = "$env:APPDATA\tabby\plugins\node_modules"
$target = "$plugins\tabby-remote"
New-Item -ItemType Directory -Force $plugins | Out-Null
$item = Get-Item $target -ErrorAction SilentlyContinue
if (-not $item) {
    New-Item -ItemType Junction -Path $target -Target $repo | Out-Null
} elseif ($item.LinkType -eq 'Junction') {
    if ($item.Target -ne $repo) { Write-Warning "tabby-remote already links to $($item.Target)" }
} else {
    Write-Warning "$target is a copied folder, not a link"
}
```

macOS:

```sh
plugins="$HOME/Library/Application Support/tabby/plugins/node_modules"
target="$plugins/tabby-remote"
mkdir -p "$plugins"
if [ -L "$target" ]; then
  [ "$(readlink "$target")" = "$repo" ] || echo "WARNING: tabby-remote already links to $(readlink "$target")"
elif [ -e "$target" ]; then
  echo "WARNING: $target is a copied folder, not a link"
else
  ln -s "$repo" "$target"
fi
```

If a warning shows, ask the user before you change it. A copied folder may be an older install they edit by hand. Replacing it means renaming it (for example to `tabby-remote.old`) and running this step again.

## 4. Restart Tabby

Ask the user to quit Tabby (macOS: Cmd+Q, not just closing the window) and start it again. Tabby loads plugins only at startup.

Do not kill Tabby's process: a killed Tabby loses its last saved tabs.

| System | First start |
| --- | --- |
| Windows | A Windows Firewall prompt may ask about Tabby. Allow it on **private** networks, so phones on the same Wi-Fi can connect, and so this computer's other computers find it (a small announcement on UDP port 41681; when blocked, the phone's list of computers is just empty). |
| macOS | If the macOS firewall is on, it asks whether Tabby may accept incoming connections: **Allow**. If it was denied earlier, re-allow Tabby in System Settings > Network > Firewall > Options. |

## 5. Verify

Windows:

```powershell
Invoke-RestMethod http://127.0.0.1:7681/api/info
```

macOS:

```sh
curl -s http://127.0.0.1:7681/api/info
```

Expect `{ tabby, plugin, host, id, name, port, password, groups }`. `"password": false` only means password sign-in is not set up; it does not open anything: a device still needs the single-use code from the QR (or a password, once one is set) to get in.

| Result | Meaning |
| --- | --- |
| Answers | Installed and running. `groups: true` means tabby-groups is installed too. |
| Connection refused | Tabby has not been restarted, or the port was changed in Settings > Phone access. Check whether `tabby-remote.json` in Tabby's data folder has a different `port`. |
| Another app answers | Something else holds port 7681. Pick another port in Settings > Phone access and restart Tabby. |

## 6. Hand over to the user

Tell the user:

| To | Do |
| --- | --- |
| Pair a phone or tablet | Click the QR button in Tabby's toolbar and scan it with the phone's camera (same Wi-Fi). |
| Change settings | Tabby **Settings > Phone access**: address, keep awake, password, port, paired devices. |
| Install it as an app | On the phone, Share > Add to Home Screen |
| Get the groups sidebar | Optionally install tabby-groups (https://github.com/robw0ng/tabby-groups) the same way. Without it, the phone lists plain tabs. |

## Update later

Step 1, then step 4. Step 2 only if `package.json` changed.

## Uninstall

Windows:

```powershell
Remove-Item "$env:APPDATA\tabby\plugins\node_modules\tabby-remote"
```

macOS:

```sh
rm "$HOME/Library/Application Support/tabby/plugins/node_modules/tabby-remote"
```

Each removes only the link and leaves the clone alone. Restart Tabby afterwards. Paired devices and settings stay in `tabby-remote.json` in Tabby's data folder (`%APPDATA%\tabby`, `~/Library/Application Support/tabby`) until that file is deleted.
