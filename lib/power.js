const { powerSaveBlocker } = require('@electron/remote')

/**
 * Keeps the computer awake while a device has a tab open, and for a while (30 minutes by default) after the last one
 * leaves: a phone that locks drops its connection, and should still find the computer awake when it comes back.
 *
 * "Keep the screen on" also stops the screen turning off. That matters on laptops with Modern Standby: there the
 * screen turning off locks the computer and lets it drift into standby, which pauses Tabby although sleep is blocked.
 */
module.exports = ctx => {
    const { store, clients } = ctx
    let awake = null
    let screenOn = null
    let timer = null

    function stayAwake () {
        if (!store.keepAwake && !store.keepScreen) return letSleep()
        if (clients.size) {
            clearTimeout(timer)
            timer = null
            if (awake === null) awake = powerSaveBlocker.start('prevent-app-suspension')
            if (store.keepScreen && screenOn === null) screenOn = powerSaveBlocker.start('prevent-display-sleep')
            if (!store.keepScreen && screenOn !== null) {
                powerSaveBlocker.stop(screenOn)
                screenOn = null
            }
        } else if ((awake !== null || screenOn !== null) && !timer) {
            timer = setTimeout(letSleep, store.awakeMinutes * 60 * 1000)
        }
    }

    function letSleep () {
        clearTimeout(timer)
        timer = null
        if (awake !== null) powerSaveBlocker.stop(awake)
        if (screenOn !== null) powerSaveBlocker.stop(screenOn)
        awake = screenOn = null
    }

    ctx.cleanup.push(letSleep)
    return {
        stayAwake,
        awake: () => awake !== null && powerSaveBlocker.isStarted(awake),
        screenOn: () => screenOn !== null && powerSaveBlocker.isStarted(screenOn),
    }
}
