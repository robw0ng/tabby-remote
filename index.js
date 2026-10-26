const { NgModule, Injector, NgZone, ElementRef, ɵɵdefineComponent, ɵɵdirectiveInject } = require('@angular/core')
const core = require('tabby-core')
const os = require('os')
const path = require('path')
const { loadStore } = require('./lib/store')

const VERSION = require('./package.json').version

// Each part adds its functions to the shared context and calls the others through it, so their order only matters
// for what a part does as it starts.
const PARTS = ['model', 'presence', 'power', 'size', 'attach', 'devices', 'tailscale', 'pairing', 'sessions', 'events', 'files', 'identity', 'share', 'move', 'talk', 'routes', 'server', 'discovery', 'settings']

function install (injector) {
    // Reloading in place (new files, Tabby kept running): the old instance lets go first, and the new server starts
    // once the old one has released its port.
    const previous = Promise.resolve(window.__tabbyRemote?.dispose()).catch(() => {})

    const zone = injector.get(NgZone)
    // userData honours --user-data-dir; Tabby's config path does not.
    const storePath = path.join(require('@electron/remote').app.getPath('userData'), 'tabby-remote.json')
    const { store, write } = loadStore(storePath)
    const ctx = {
        version: VERSION,
        injector,
        previous,
        store,
        app: injector.get(core.AppService),
        profiles: injector.get(core.ProfilesService),
        notifications: injector.get(core.NotificationsService),
        config: injector.get(core.ConfigService),
        // Node's sockets call back outside Angular's zone; without this Tabby never renders a tab we open.
        inZone: fn => (...args) => zone.run(() => fn(...args)),
        disposed: false,
        // After dispose this instance never writes again, so a stale copy cannot overwrite the new one's settings.
        save: () => ctx.disposed || write(),
        // A port set in Settings applies after a restart; when it is taken, the next free one (see startServers).
        listeningPort: store.port,
        // Attached panes: { conn, device, pane, size, away, lastInput }. Event listeners: { conn, device }.
        clients: new Set(),
        eventClients: new Set(),
        groups: () => window.__tabbyGroups,
        computerName: () => store.name || os.hostname(),
        // What dispose runs, in order; a part that releases something slowly returns a promise.
        cleanup: [],
    }
    for (const part of PARTS) Object.assign(ctx, require(`./lib/${part}`)(ctx))
    if (store.enabled) ctx.startServers()

    window.__tabbyRemote = {
        version: VERSION,
        storePath,
        showQr: ctx.inZone(ctx.showQr),
        clients: () => [...ctx.clients].map(c => ({ device: c.device.name, pane: c.pane.__trId })),
        awake: ctx.awake,
        screenOn: ctx.screenOn,
        renderSettings: ctx.inZone(ctx.renderSettings),
        /** The files of the computers this one is linked to (tabby-files' Files tab): computers(), fetch(id, op, …). */
        files: ctx.filesApi,
        /** Message a Claude tab on a linked computer (tabby-groups' tab-say.mjs --computer): say(computer, tab, message, from), chats(computer). */
        talk: ctx.talkApi,
        /** A Claude tab's right-click menu: Send to computer ▸ one of the others seen on the network. */
        tabMenu (tab) {
            if (!ctx.claudeSessionOf(tab) || !ctx.canMove()) return []
            const targets = ctx.moveTargets()
            const send = id => ctx.inZone(() => ctx.sendWithNotice(tab, id))
            return [{
                label: 'Send to computer',
                submenu: targets.length
                    ? targets.map(c => c.linked ? { label: c.name, click: send(c.computerId) } : { label: `${c.name} (link it in Settings > Phone access)`, enabled: false })
                    : [{ label: 'No other computers seen on this network', enabled: false }],
            }]
        },
        /** Loads this plugin's files again from disk and swaps the running instance for the new one. */
        reload () {
            Object.keys(require.cache).filter(f => f.startsWith(__dirname + path.sep)).forEach(f => delete require.cache[f])
            return require(__filename).install(injector)
        },
        /** Stops everything this instance started; resolves once its servers have released the port. */
        dispose () {
            ctx.disposed = true
            ;[...ctx.clients, ...ctx.eventClients].forEach(c => c.conn.close(1001))
            const released = ctx.cleanup.map(stop => stop())
            delete window.__tabbyRemote
            // Never waits long: a socket that will not close does not hold up the next instance.
            return Promise.race([Promise.all(released), new Promise(resolve => setTimeout(resolve, 2000))])
        },
    }
    return window.__tabbyRemote
}

class TabbyRemoteModule {
    constructor (injector) {
        install(injector)
    }
}
TabbyRemoteModule.ctorParameters = () => [{ type: Injector }]

// Lucide 'qr-code' (ISC, lucide.dev).
const QR_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="5" height="5" x="3" y="3" rx="1"/><rect width="5" height="5" x="16" y="3" rx="1"/><rect width="5" height="5" x="3" y="16" rx="1"/><path d="M21 16h-3a2 2 0 0 0-2 2v3"/><path d="M21 21v.01"/><path d="M12 7v3a2 2 0 0 1-2 2H7"/><path d="M3 12h.01"/><path d="M12 3h.01"/><path d="M12 16v.01"/><path d="M16 12h1"/><path d="M21 12v.01"/><path d="M12 21v-1"/></svg>'

class RemoteButtonProvider extends core.ToolbarButtonProvider {
    provide () {
        return [{ icon: QR_ICON, title: 'Phone access', weight: 5, click: () => window.__tabbyRemote?.showQr() }]
    }
}

// Built by install(), so a hot reload brings new items.
class RemoteTabMenuProvider extends core.TabContextMenuItemProvider {
    async getItems (tab) {
        return window.__tabbyRemote?.tabMenu(tab) ?? []
    }
}

// Settings > Phone access. Tabby has no template compiler at run time, so the component is declared by hand,
// with an empty template; install() fills it with plain DOM, and a hot reload brings the new page with it.
class RemoteSettingsComponent {
    constructor (ref) {
        this.host = ref.nativeElement
    }

    ngOnInit () {
        window.__tabbyRemote?.renderSettings(this.host)
    }
}
RemoteSettingsComponent.ɵfac = () => new RemoteSettingsComponent(ɵɵdirectiveInject(ElementRef))
RemoteSettingsComponent.ɵcmp = ɵɵdefineComponent({ type: RemoteSettingsComponent, selectors: [['tabby-remote-settings']], decls: 0, vars: 0, template: () => { }, encapsulation: 2 })

const settings = require('tabby-settings')
class RemoteSettingsTabProvider extends settings.SettingsTabProvider {
    constructor () {
        super()
        this.id = 'tabby-remote'
        this.icon = 'mobile-alt'
        this.title = 'Phone access'
    }

    getComponentType () {
        return RemoteSettingsComponent
    }
}

module.exports = NgModule({
    providers: [
        { provide: core.ToolbarButtonProvider, useClass: RemoteButtonProvider, multi: true },
        { provide: core.TabContextMenuItemProvider, useClass: RemoteTabMenuProvider, multi: true },
        { provide: settings.SettingsTabProvider, useClass: RemoteSettingsTabProvider, multi: true },
    ],
})(TabbyRemoteModule)
module.exports.default = module.exports
module.exports.install = install
