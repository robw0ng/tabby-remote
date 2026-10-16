/** Opening and changing tabs for the API, with tabby-groups when it is installed. */
module.exports = ctx => {
    const { app, profiles, injector } = ctx

    // For a command without a named shell: the user's own shell on macOS and Linux; on Windows, PowerShell 7 when
    // installed, else Windows PowerShell, which every Windows has. On macOS a login shell, as Tabby's own default
    // profile starts, so PATH has Homebrew's tools; zsh has been the Mac default since 10.15.
    const win = process.platform === 'win32'
    const mac = process.platform === 'darwin'
    const defaultShell = !win ? process.env.SHELL || (mac ? '/bin/zsh' : '/bin/sh')
        : require('child_process').spawnSync('where', ['pwsh.exe'], { windowsHide: true }).status === 0 ? 'pwsh.exe' : 'powershell.exe'
    const defaultArgs = win ? ['-NoLogo'] : mac ? ['--login'] : []

    const outerTab = inner => inner && (app.getParentTab(inner) ?? inner)

    async function openSession ({ profile, command, args, cwd, run, title, group, parent }) {
        const groups = ctx.groups()
        const into = tab => {
            if (tab && title) tab.setCustomTitle(title)
            if (tab && group) groups?.addTab(tab, group, parent !== undefined ? { parent } : {})
            return tab ?? null
        }
        if (profile) {
            const p = (await profiles.getProfiles()).find(x => x.id === profile || x.name === profile)
            if (!p) return null
            return into(outerTab(await profiles.openNewTabForProfile(p)))
        }
        if (!command && !run) {
            // A plain new tab opens the default profile, exactly as Tabby's own + does (and tabby-groups' group +).
            return into(outerTab(await injector.get(require('tabby-local').TerminalService).openTab(undefined, cwd)))
        }
        if (groups) {
            // Always name the shell: tabby-groups' own default, `pwsh.exe`, is missing on a Mac and on many PCs.
            const index = await groups.open({ title, command: command ?? defaultShell, args: args ?? (command ? [] : defaultArgs), cwd, run, group, parent })
            return app.tabs[index - 1] ?? null
        }
        // Without tabby-groups, `run` and `group` are ignored.
        const tab = outerTab(await profiles.openNewTabForProfile({ type: 'local', name: title ?? command ?? 'Shell', options: { command: command ?? defaultShell, args: args ?? (command ? [] : defaultArgs), cwd, env: {} } }))
        if (tab && title) tab.setCustomTitle(title)
        return tab ?? null
    }

    function changeSession (tab, { title, group, parent, pinned, focus }) {
        const groups = ctx.groups()
        // An empty title clears the custom one, so the shell's own title shows again.
        if (typeof title === 'string') tab.setCustomTitle(title)
        if (group === null) groups?.removeTab(tab)
        else if (typeof group === 'string') groups?.addTab(tab, group, parent !== undefined ? { parent } : {})
        // tabby-groups pins inside the tab's group, or with Tabby's own pin when the tab is loose.
        if (typeof pinned === 'boolean') groups?.setTabPinned(tab, pinned)
        if (focus) app.selectTab(tab)
        setTimeout(ctx.tick)
    }

    return { openSession, changeSession }
}
