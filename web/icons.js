// Icons for the sidebar and the header, and Claude's marks on them.

function iconFor (kind, size = 16) {
    const i = icons[kind]
    // A user's own icon (tabby-groups) may be an emoji.
    if (i?.emoji) return el('span', { className: 'emoji', textContent: i.emoji, style: `font-size:${Math.round(size * 0.9)}px;line-height:${size}px` })
    const ns = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(ns, 'svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('width', size)
    svg.setAttribute('height', size)
    svg.setAttribute('aria-hidden', 'true')
    // Unknown kinds get a plain prompt glyph.
    const paths = i ? (i.paths ?? [i.path]) : ['M4 17l6-5-6-5', 'M12 19h8']
    const stroke = !i || i.stroke
    for (const d of paths) {
        const p = document.createElementNS(ns, 'path')
        p.setAttribute('d', d)
        if (stroke) {
            p.setAttribute('fill', 'none')
            p.setAttribute('stroke', i?.color ?? '#bbb')
            p.setAttribute('stroke-width', '2')
            p.setAttribute('stroke-linecap', 'round')
            p.setAttribute('stroke-linejoin', 'round')
        } else {
            p.setAttribute('fill', i.color)
        }
        svg.appendChild(p)
    }
    return svg
}

// Font Awesome 'thumbtack' (CC BY 4.0), the glyph Tabby uses for a pinned tab.
const PIN = 'M32 32C32 14.3 46.3 0 64 0H320c17.7 0 32 14.3 32 32s-14.3 32-32 32H290.5l11.4 148.2c36.7 19.9 65.7 53.2 79.5 94.7l1 3c3.3 9.8 1.6 20.5-4.4 28.8s-15.7 13.3-26 13.3H32c-10.3 0-19.9-4.9-26-13.3s-7.7-19.1-4.4-28.8l1-3c13.8-41.5 42.8-74.8 79.5-94.7L93.5 64H64C46.3 64 32 49.7 32 32zM160 384h64v96c0 17.7-14.3 32-32 32s-32-14.3-32-32V384z'

function pinIcon () {
    const ns = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(ns, 'svg')
    svg.setAttribute('viewBox', '0 0 384 512')
    svg.setAttribute('width', 10)
    svg.setAttribute('height', 12)
    const p = document.createElementNS(ns, 'path')
    p.setAttribute('d', PIN)
    p.setAttribute('fill', 'currentColor')
    svg.appendChild(p)
    return svg
}

/** Lucide 'monitor' (ISC). */
function monitorIcon () {
    const ns = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(ns, 'svg')
    for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: 10, height: 10, fill: 'none', stroke: 'currentColor', 'stroke-width': 2.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) svg.setAttribute(k, v)
    for (const d of ['M2 3h20v14H2z', 'M8 21h8', 'M12 17v4']) {
        const p = document.createElementNS(ns, 'path')
        p.setAttribute('d', d)
        svg.appendChild(p)
    }
    return svg
}

/** Lucide 'chevron-right' (ISC, lucide.dev); it turns to point down when the group is open. Shared with tabby-groups. */
function chevron () {
    const ns = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(ns, 'svg')
    for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: 12, height: 12, fill: 'none', stroke: 'currentColor', 'stroke-width': 2.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, v)
    const p = document.createElementNS(ns, 'path')
    p.setAttribute('d', 'm9 18 6-6-6-6')
    svg.appendChild(p)
    return svg
}

/** Lucide 'minimize-2' (ISC, lucide.dev): four strokes pointing inward. */
function compressIcon () {
    const ns = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(ns, 'svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    for (const d of ['M4 14h6v6', 'M20 10h-6V4', 'M14 10l7-7', 'M3 21l7-7']) {
        const p = document.createElementNS(ns, 'path')
        p.setAttribute('d', d)
        svg.appendChild(p)
    }
    return svg
}

/**
 * Claude's marks on a tab's icon (app.css): while it asks, ? for a question or ! for a permission prompt (top
 * right); while tasks run in the background, a green pill with their count (bottom right); while it compacts its
 * context, a violet badge (bottom left).
 */
function agentMarks (icon, agent) {
    if (agent?.asking) icon.dataset.ask = agent.asking.kind === 'permission' ? '!' : '?'
    if (agent?.compacting) icon.append(el('span', { className: 'compacting', title: `Compacting context (${agent.compacting.trigger})` }, compressIcon()))
    const bg = agent?.background
    if (bg?.count) {
        const what = bg.labels?.length ? bg.labels.join(', ') : `${bg.count} task${bg.count === 1 ? '' : 's'}`
        icon.append(el('span', { className: 'running', textContent: bg.count, title: `Running in background: ${what}` }))
    }
    return icon
}
