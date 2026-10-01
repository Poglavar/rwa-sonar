/* Shared research-station geometry and flight poses for the interactive map and exported loops. */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./monitoring-map.js'));
    else root.__rwaResearchFleet = factory(root.__rwaMonitoringMap);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (M) {
    'use strict';
    const ASSETS = Object.freeze({
        station: './images/research-fleet/station-v1.webp',
        ship: './images/research-fleet/research-ship-v1.webp'
    });
    const escape = (value) => String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

    function buildFleet(groups, width, height) {
        const scene = M.layoutSources(groups, width, height);
        scene.width = width; scene.height = height;
        scene.stationSize = width < 600 ? 112 : 148;
        const launchRadius = width < 600 ? 42 : 56;
        scene.flights = scene.nodes.flatMap((node) => {
            node.start = { x: scene.center.x + Math.cos(node.angle) * launchRadius, y: scene.center.y + Math.sin(node.angle) * launchRadius };
            node.bend = ((M.hash(node.id) % 7) - 3) * .032;
            // Separate issuer-specific missions share a source world; repeated URLs within one
            // mission travel together. Prepared and conditional routes never launch a ship.
            const bundles = new Map();
            for (const route of node.routes.filter((route) => route.state === 'configured')) {
                const key = `${route.jobId}:${route.cadenceHours}:${route.issuerIds.join(',')}`;
                if (!bundles.has(key)) bundles.set(key, route);
            }
            const color = M.CATEGORIES.find((category) => category.id === node.category)?.color || M.CATEGORIES[0].color;
            return [...bundles.values()].map((route, index) => ({ route, node, start: node.start,
                bend: node.bend + (index % 5 - 2) * .02,
                color: M.CATEGORIES.find((category) => category.id === route.category)?.color || color }));
        });
        return scene;
    }
    function shipPose(flight, time, secondsPerHour = 4) {
        const phase = M.shipPhase(flight.route, time, secondsPerHour);
        if (!phase) return null;
        const point = M.curvePoint(flight.start, flight.node, flight.bend, phase.progress);
        return { x: point.x, y: point.y, angle: point.angle + (phase.returning ? Math.PI : 0), returning: phase.returning };
    }
    function stationSvg(scene, href = ASSETS.station, withLabel = true) {
        const size = scene.stationSize;
        return `<g class="research-station" transform="translate(${scene.center.x} ${scene.center.y})" aria-hidden="true">`
            + `<circle r="${size * .68}" fill="url(#station-glow)"/>`
            + `<image class="research-station-image" href="${escape(href)}" x="${-size / 2}" y="${-size / 2}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid meet"/>`
            + (withLabel ? `<text class="station-label" y="${scene.width < 600 ? 83 : 112}" text-anchor="middle">RWA SONAR</text><text class="station-subtitle" y="${scene.width < 600 ? 97 : 126}" text-anchor="middle">RESEARCH STATION</text>` : '') + '</g>';
    }
    return { ASSETS, buildFleet, shipPose, stationSvg };
});
