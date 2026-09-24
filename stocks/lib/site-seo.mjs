// Search, social-preview and contact markup shared by every page: the <head> SEO block (title,
// description, canonical, OpenGraph, X card, JSON-LD) and the site-wide contact footer. Used by the
// generated page families (cards, issuers, templates, protocols, weekly) and, through marked regions,
// by the hand-written pages (stocks/build-site-seo.mjs). Pure: no I/O, no clock.

import fmt from './fmt.js';

const { escapeHtml } = fmt;

export const SITE_ORIGIN = 'https://rwasonar.com';
export const SITE_NAME = 'RWA Sonar';
export const X_HANDLE = '@RWASonar';
/** Every public contact channel. No e-mail address is published: none has been confirmed. */
export const CONTACT_LINKS = {
    x: 'https://x.com/RWASonar',
    telegramGroup: 'https://t.me/+eVeOD--RTv1kNDQx',
    telegramGroupName: 'RWA Sonar Watch',
    telegramChannel: 'https://t.me/rwasonar',
    github: 'https://github.com/Poglavar/rwa-sonar',
    bot: 'https://t.me/rwa_sonar_bot',
    botName: '@rwa_sonar_bot'
};
/** The site-wide 1200×630 image: the fallback whenever a page's own image could not be rendered. */
export const SITE_IMAGE = {
    url: `${SITE_ORIGIN}/images/og-rwasonar.png?v=20260923`,
    alt: 'RWA Sonar: tokenized stocks on Solana, compared by what you actually own',
    width: 1200,
    height: 630
};
/** Search engines cut a meta description near here; og:description may run longer. */
export const META_DESCRIPTION_MAX = 160;
/** Cache-busting stamp for site-contact.css. Bump when it changes. */
export const CONTACT_CSS_VERSION = '20260924a';

/** `text` cut to `max` characters at a word boundary with an ellipsis; whitespace collapsed. */
export function clampText(text, max = META_DESCRIPTION_MAX) {
    const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (clean.length <= max) return clean;
    const cut = clean.slice(0, max - 1);
    const space = cut.lastIndexOf(' ');
    return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s.,;:·—–-]+$/, '')}…`;
}

/** Origin without a trailing slash, or null when none was stated (a builder never guesses one). */
export function originOf(baseUrl) {
    return typeof baseUrl === 'string' && baseUrl.trim() ? baseUrl.trim().replace(/\/+$/, '') : null;
}

/**
 * One `<script type="application/ld+json">` block. `</` is escaped so no string in the data can
 * close the element; the type makes it inert data, which the no-inline-script CSP allows.
 */
export function jsonLdScript(data) {
    return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;
}

export function organizationLd(origin = SITE_ORIGIN) {
    return {
        '@type': 'Organization',
        '@id': `${origin}/#organization`,
        name: SITE_NAME,
        url: `${origin}/`,
        logo: `${origin}/images/rwasonar-logo.svg`,
        sameAs: [CONTACT_LINKS.x, CONTACT_LINKS.github, CONTACT_LINKS.telegramChannel, CONTACT_LINKS.telegramGroup]
    };
}

export function websiteLd(origin = SITE_ORIGIN) {
    return {
        '@type': 'WebSite',
        '@id': `${origin}/#website`,
        name: SITE_NAME,
        url: `${origin}/`,
        description: 'Public research on tokenized stocks on Solana: what the holder legally owns, who can intervene on-chain and off-chain, where the token can be used and how to exit, with cited evidence.',
        publisher: { '@id': `${origin}/#organization` },
        inLanguage: 'en',
        potentialAction: {
            '@type': 'SearchAction',
            target: { '@type': 'EntryPoint', urlTemplate: `${origin}/stocks.html?view=assets&search={search_term_string}` },
            'query-input': 'required name=search_term_string'
        }
    };
}

/** `[{name, url}]` from the home page down to this one. */
export function breadcrumbLd(items) {
    return {
        '@type': 'BreadcrumbList',
        itemListElement: items.map((item, index) => ({ '@type': 'ListItem', position: index + 1, name: item.name, item: item.url }))
    };
}

/** A research report page (card, dossier, template, weekly digest). Dates only when the data has them. */
export function reportLd({ origin = SITE_ORIGIN, url, headline, description, dateModified = null, image = null, about = null, type = 'Report' }) {
    const out = {
        '@type': type,
        headline: clampText(headline, 110),
        description,
        url,
        mainEntityOfPage: url,
        inLanguage: 'en',
        author: { '@id': `${origin}/#organization` },
        publisher: { '@id': `${origin}/#organization` },
        isPartOf: { '@id': `${origin}/#website` }
    };
    if (dateModified) out.dateModified = dateModified;
    if (image) out.image = image;
    if (about) out.about = about;
    return out;
}

/**
 * A data view: the page and the machine-readable files and API routes behind it. No licence is
 * stated because the owner has not chosen one yet (README "License"); saying one would be invented.
 */
export function datasetLd({ origin = SITE_ORIGIN, url, name, description, dateModified = null, distribution = [], keywords = [] }) {
    const out = {
        '@type': 'Dataset',
        name,
        description,
        url,
        isAccessibleForFree: true,
        creator: { '@id': `${origin}/#organization` },
        publisher: { '@id': `${origin}/#organization` },
        includedInDataCatalog: { '@type': 'DataCatalog', name: SITE_NAME, url: `${origin}/` }
    };
    if (keywords.length) out.keywords = keywords;
    if (dateModified) out.dateModified = dateModified;
    if (distribution.length) {
        out.distribution = distribution.map((row) => ({
            '@type': 'DataDownload',
            encodingFormat: row.format ?? 'application/json',
            contentUrl: /^https?:/.test(row.url) ? row.url : `${origin}/${row.url.replace(/^\//, '')}`,
            ...(row.name ? { name: row.name } : {})
        }));
    }
    return out;
}

export function webPageLd({ origin = SITE_ORIGIN, url, name, description, type = 'WebPage', dateModified = null }) {
    const out = { '@type': type, name, description, url, inLanguage: 'en', isPartOf: { '@id': `${origin}/#website` } };
    if (dateModified) out.dateModified = dateModified;
    return out;
}

/** Wraps nodes in one @graph document so each page carries a single JSON-LD block. */
export function ldGraph(nodes) {
    return { '@context': 'https://schema.org', '@graph': nodes.filter(Boolean) };
}

/**
 * The SEO part of a <head>, one tag per element in `sep`-joined text. `url` null (no stated origin)
 * drops canonical, og:url, the image and the JSON-LD rather than guessing an origin. `image` is
 * `{url, alt, width, height}` with an absolute url, else the site image. `description` is clamped
 * to META_DESCRIPTION_MAX for the meta tag; `socialDescription` (default: the same) may be longer.
 */
export function seoHeadTags({
    title, description, socialTitle = null, socialDescription = null, url = null, type = 'website',
    image = null, jsonLd = null, robots = null, sep = ''
}) {
    const e = escapeHtml;
    const meta = clampText(description, META_DESCRIPTION_MAX);
    const social = clampText(socialDescription ?? description, 200);
    const ogTitle = socialTitle ?? title;
    const img = url === null ? null : (image?.url ? image : SITE_IMAGE);
    const tags = [
        `<title>${e(title)}</title>`,
        `<meta name="description" content="${e(meta)}" />`,
        robots ? `<meta name="robots" content="${e(robots)}" />` : null,
        url === null ? null : `<link rel="canonical" href="${e(url)}" />`,
        `<meta property="og:site_name" content="${SITE_NAME}" />`,
        `<meta property="og:type" content="${e(type)}" />`,
        `<meta property="og:title" content="${e(ogTitle)}" />`,
        `<meta property="og:description" content="${e(social)}" />`,
        url === null ? null : `<meta property="og:url" content="${e(url)}" />`,
        '<meta property="og:locale" content="en_US" />',
        img === null ? null : `<meta property="og:image" content="${e(img.url)}" />`,
        img === null ? null : '<meta property="og:image:type" content="image/png" />',
        img === null ? null : `<meta property="og:image:width" content="${img.width ?? 1200}" />`,
        img === null ? null : `<meta property="og:image:height" content="${img.height ?? 630}" />`,
        img === null ? null : `<meta property="og:image:alt" content="${e(img.alt ?? SITE_IMAGE.alt)}" />`,
        `<meta name="twitter:card" content="${img === null ? 'summary' : 'summary_large_image'}" />`,
        `<meta name="twitter:site" content="${X_HANDLE}" />`,
        `<meta name="twitter:creator" content="${X_HANDLE}" />`,
        `<meta name="twitter:title" content="${e(ogTitle)}" />`,
        `<meta name="twitter:description" content="${e(social)}" />`,
        img === null ? null : `<meta name="twitter:image" content="${e(img.url)}" />`,
        img === null ? null : `<meta name="twitter:image:alt" content="${e(img.alt ?? SITE_IMAGE.alt)}" />`,
        url === null || !jsonLd ? null : jsonLdScript(jsonLd)
    ];
    return tags.filter((tag) => tag !== null).join(sep);
}

/**
 * The site-wide contact footer. `root` is the relative path to the site root from the page
 * ('./', '../'). Its stylesheet is `${root}site-contact.css`, linked by contactStylesheet().
 * `variant: 'dark'` is for a page whose body text colour is not readable on its background (the
 * pitch deck draws its slides on a dark body).
 */
export function contactFooterHtml(root = './', { variant = null } = {}) {
    const ext = 'target="_blank" rel="noopener noreferrer"';
    return `<footer class="site-contact${variant === 'dark' ? ' site-contact-dark' : ''}" aria-label="Contact and community">`
        + `<p class="site-contact-title">Follow RWA Sonar, ask a question or get alerts</p><ul>`
        + `<li><a href="${CONTACT_LINKS.x}" target="_blank" rel="me noopener noreferrer">X <span>@RWASonar</span></a></li>`
        + `<li><a href="${CONTACT_LINKS.telegramChannel}" ${ext}>Telegram channel <span>RWA Sonar</span></a></li>`
        + `<li><a href="${CONTACT_LINKS.telegramGroup}" ${ext}>Telegram group <span>${CONTACT_LINKS.telegramGroupName}</span></a></li>`
        + `<li><a href="${CONTACT_LINKS.bot}" ${ext}>Private alerts bot <span>${CONTACT_LINKS.botName}</span></a> <a class="site-contact-aside" href="${root}watch.html">set up a watch</a></li>`
        + `<li><a href="${CONTACT_LINKS.github}" ${ext}>GitHub <span>Poglavar/rwa-sonar</span></a></li>`
        + '</ul></footer>';
}

export function contactStylesheet(root = './') {
    return `<link rel="stylesheet" href="${root}site-contact.css?v=${CONTACT_CSS_VERSION}" />`;
}

/**
 * Replaces the content between `<!-- seo:NAME:start -->` and `<!-- seo:NAME:end -->`. A missing or
 * repeated marker throws: a silently skipped region would leave a stale head in place.
 */
export function replaceSeoRegion(html, name, content) {
    const start = `<!-- seo:${name}:start -->`;
    const end = `<!-- seo:${name}:end -->`;
    const from = html.indexOf(start);
    const to = html.indexOf(end);
    if (from === -1 || to === -1 || to < from) throw new Error(`seo region "${name}" is not marked`);
    if (html.indexOf(start, from + 1) !== -1 || html.indexOf(end, to + 1) !== -1) {
        throw new Error(`seo region "${name}" is marked more than once`);
    }
    return html.slice(0, from + start.length) + content + html.slice(to);
}

/** The content currently between a region's markers, or null when the page has no such region. */
export function readSeoRegion(html, name) {
    const start = `<!-- seo:${name}:start -->`;
    const from = html.indexOf(start);
    const to = html.indexOf(`<!-- seo:${name}:end -->`);
    return from === -1 || to === -1 ? null : html.slice(from + start.length, to);
}
