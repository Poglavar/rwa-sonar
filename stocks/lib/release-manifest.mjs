// The single release boundary for generated stock research.  Keep source observation times in
// their own payloads; this only says which complete set is published together.
export const RELEASE_ARTIFACTS = [
    'release-evidence.json',
    'stocks-issuers.json', 'stocks-tokens.json', 'stocks-discovery.json', 'stocks-funnel.json',
    'stocks-graph.json', 'stocks-health.json', 'stocks-collector-status.json', 'stocks-review-queue.json',
    'stocks-afterhours.json', 'stocks-changes.json', 'stocks-change-journal.json', 'stocks-defi-changes.json',
    'stocks-legal-templates.json',
    'stocks/data/venues.json', 'stocks/data/holders.json', 'stocks/data/meteora.json',
    'stocks/data/reference-prices.json', 'stocks/data/events.json', 'stocks/data/defi-usage.json',
    'stocks/data/discovery-candidates.json', 'stocks/data/identity-onchain.json', 'stocks/data/mint-identities.json',
    'stocks/data/history', 'cards', 'templates', 'issuers', 'protocols', 'comparisons',
    // Analysis pages added 2026-09-24: power map, flows and float, premium tracking, exit routes, weekly.
    'stocks-power-map.json', 'stocks-flows.json', 'stocks-tracking.json', 'stocks-exits.json', 'weekly',
    // Page preview images and the sitemaps (stocks/build-site-seo.mjs).
    'og', 'sitemap.xml', 'sitemaps',
    // DeFi additions feed (New in DeFi strip) and the curated program registry it attributes with.
    'stocks-defi-new.json', 'stocks/data/defi-program-registry.json',
    // Redemption, creation, what-if and relationship diagrams (stocks/build-schematics.mjs).
    'stocks-schematics.json'
];

// Release construction has explicit phases because the review queue reads the database, while
// cards/templates must be regenerated after that queue exists.  `base` rebuilds the catalogue
// from retained raw inputs (including curated dossier changes); it never collects a source.
export const RELEASE_BUILD_STAGES = {
    base: [
        'stocks/build-stocks-db.mjs', 'stocks/build-graph.mjs', 'stocks/build-health.mjs',
        'stocks/build-discovery-index.mjs',
        // Read the catalogue build-stocks-db just wrote.
        'stocks/build-power-map.mjs', 'stocks/build-flows.mjs', 'stocks/build-schematics.mjs',
        // Rebuilds the DeFi change feed and "New in DeFi" from stored daily snapshots only (no fetch),
        // so a deploy never serves a locally built feed until the next midnight refresh.
        'stocks/build-defi-changes.mjs'
    ],
    'pre-review': ['stocks/build-legal-templates.mjs'],
    surfaces: [
        'stocks/build-legal-templates.mjs', 'stocks/build-cards.mjs',
        'stocks/build-protocol-dossiers.mjs', 'stocks/build-comparison-bundles.mjs',
        // Exits reads protocols/index.json; tracking reads the after-hours output; weekly reads the
        // snapshot, changes, journal and database state, so all three come after the dossiers.
        'stocks/build-exits.mjs', 'stocks/build-tracking.mjs', 'stocks/build-weekly.mjs',
        // Last: reads the finished catalogue, templates and health. index.html and pitch/index.html
        // are ordinary site files, not manifest families; refresh-on-server.sh installs them itself.
        'stocks/build-static-snapshot.mjs',
        // After the snapshot: writes each page's head block, preview image and the sitemaps.
        'stocks/build-site-seo.mjs'
    ]
};

export const RELEASE_BUILDERS = Object.values(RELEASE_BUILD_STAGES).flat();

export function releaseArtifactPaths() {
    return [...RELEASE_ARTIFACTS];
}

export function releaseRsyncExcludes() {
    return ['.rwa-release-current', ...RELEASE_ARTIFACTS];
}

// Kept executable for the shell deploy entrypoint.  One source of truth also prevents rsync
// from overwriting a staged release family before publish-release installs it.
if (import.meta.filename === process.argv[1]) {
    if (process.argv[2] !== '--rsync-excludes') {
        console.error('usage: node stocks/lib/release-manifest.mjs --rsync-excludes');
        process.exit(1);
    }
    // The pointer is runtime publication state. `rsync --delete` must preserve it or every
    // generated alias would briefly break before the publisher runs.
    process.stdout.write(releaseRsyncExcludes().join('\n') + '\n');
}
