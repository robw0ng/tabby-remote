const ANSI = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']

/** The terminal colour scheme Tabby uses now, as an xterm.js theme. */
module.exports = function terminalTheme (config) {
    // Tabby loads its config after plugins start: no colours until then (the page keeps its defaults).
    if (!config.store?.terminal) return null
    const { terminal, appearance } = config.store
    const light = appearance?.colorSchemeMode === 'light'
        || (appearance?.colorSchemeMode === 'auto' && matchMedia('(prefers-color-scheme: light)').matches)
    const s = (light ? terminal.lightColorScheme : terminal.colorScheme) ?? {}
    const c = s.colors ?? []
    return {
        foreground: s.foreground,
        background: s.background,
        cursor: s.cursor,
        cursorAccent: s.cursorAccent,
        // Tabby's own default for a scheme without one.
        selectionBackground: s.selection ?? '#88888888',
        selectionForeground: s.selectionForeground,
        ...Object.fromEntries(ANSI.flatMap((name, i) => [[name, c[i]], ['bright' + name[0].toUpperCase() + name.slice(1), c[i + 8]]])),
    }
}
