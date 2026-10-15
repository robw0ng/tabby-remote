# Install (for an agent)

Steps an agent can follow on Windows when asked to "install https://github.com/robw0ng/tabby-remote". Every step is safe to run again. PowerShell.

## 0. Check

| Need | Check | If missing |
| --- | --- | --- |
| Tabby 1.0 | `Test-Path "$env:LOCALAPPDATA\Programs\Tabby\Tabby.exe"` | Ask the user to install Tabby from https://tabby.sh |
| Node.js and npm | `npm -v` | Ask the user to install Node.js LTS |
| Git, with access to the repo (it is private) | `git ls-remote https://github.com/robw0ng/tabby-remote` | Ask the user to sign in (`gh auth login`) |

## 1. Clone, or update

```powershell
$repo = 'C:\tabby-remote'
if (Test-Path "$repo\.git") { git -C $repo pull --ff-only } else { git clone https://github.com/robw0ng/tabby-remote $repo }
```

Use another folder if the user prefers; keep it in `$repo`.

## 2. Dependencies

```powershell
npm --prefix $repo install --omit=dev
```

## 3. Put it where Tabby loads plugins

Tabby loads each folder in `%APPDATA%\tabby\plugins\node_modules`. A link (junction) to the clone means a later update is just step 1 plus a Tabby restart.

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

If either warning shows, ask the user before you change it. A copied folder may be an older install they edit by hand. Replacing it means renaming it (for example to `tabby-remote.old`) and running this step again.

## 4. Restart Tabby

Ask the user to quit Tabby and start it again. Tabby loads plugins only at startup.

Do not kill Tabby's process: a killed Tabby loses its last saved tabs.

The first start may show a Windows Firewall prompt for Tabby. Allow it on **private** networks, so phones on the same Wi-Fi can connect.

## 5. Verify

```powershell
Invoke-RestMethod http://127.0.0.1:7681/api/info
```

Expect `{ tabby, plugin, host, password, groups }`.

| Result | Meaning |
| --- | --- |
| Answers | Installed and running. `groups: true` means tabby-groups is installed too. |
| Connection refused | Tabby has not been restarted, or the port was changed in Settings > Phone access. Check that `tabby-remote.json` in `%APPDATA%\tabby` has a different `port`. |
| Another app answers | Something else holds port 7681. Pick another port in Settings > Phone access and restart Tabby. |

## 6. Hand over to the user

Tell the user:

| To | Do |
| --- | --- |
| Pair a phone or tablet | Click the QR button in Tabby's toolbar and scan it with the phone's camera (same Wi-Fi). |
| Change settings | Tabby **Settings > Phone access**: address, keep awake, password, port, paired devices. |
| Install it as an app | On the phone, Share > Add to Home Screen |
| Get the groups sidebar | Optionally install tabby-groups (https://github.com/robw0ng/tabby-groups) the same way |

## Update later

Step 1, then step 4. Step 2 only if `package.json` changed.

## Uninstall

```powershell
Remove-Item "$env:APPDATA\tabby\plugins\node_modules\tabby-remote"
```

Removing the junction leaves the clone alone. Restart Tabby afterwards. Paired devices and settings stay in `%APPDATA%\tabby\tabby-remote.json` until that file is deleted.
