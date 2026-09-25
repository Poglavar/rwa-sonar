/*
 * The same-stock comparison: one model per wrapper, the buyer table at the top of the view
 * (buyerRows / buyerTableHtml), the rows that genuinely differ, the comparison markup with its
 * concept guides, the decision filters, and the checks that a prebuilt comparison bundle belongs
 * to the loaded catalogue.
 *
 * Moved verbatim out of stocks.js (next-steps.md F11). Pure: no DOM, no fetch; the clock only as a
 * default `now` a caller can override. UMD like the
 * other stocks/lib/*.js files: the browser loads it as a classic script before stocks.js and reads
 * window.__rwaComparisonShape; jest requires it. Tested in stocks/comparison-shape.test.js.
 */

(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./defi-view.js'), require('./discovery.js'), require('./fmt.js'), require('./evidence-view.js'), require('./issuer-labels.js'), require('./holder-rights.js'));
    else root.__rwaComparisonShape = factory(root.__rwaDefiView, root.__rwaDiscovery, root.__rwaFmt, root.__rwaEvidenceView, root.__rwaIssuerLabels, root.__rwaHolderRights);
})(this, function (defiView, discovery, fmt, evidenceView, issuerLabels, holderRightsLib) {
    const { aggregateComposabilityTemplates, lenderOutcomeModel, productDecisionProfile, redemptionUsabilitySummary } = defiView;
    const { laypersonVerdict, legalReviewStatus } = discovery;
    const { cardSlug, escapeHtml, fmtDateTime, fmtMoney, fmtPrice, fmtSignedPct, humanizeSlug, isNum, mintSuffix } = fmt;
    const { provenanceHtml, provenanceSummary } = evidenceView;
    const { issuerDossierHref } = issuerLabels;
    const { holderRightsHeadline, holderRightsRows, holderRightsStripHtml } = holderRightsLib;

    /**
     * "Jersey (Channel Islands)" -> "Jersey", "British Virgin Islands (…)" -> "BVI": the place an
     * issuer is incorporated, short enough for a table cell. Null when the dossier says it is unknown.
     */
    function shortJurisdiction(value) {
        const text = typeof value === 'string' ? value.trim() : '';
        if (!text || /^(unknown|not |undisclosed)/i.test(text)) return null;
        const head = text.split(/[(.;,]| - /)[0].trim()
            .replace(/^Republic of the /i, '')
            .replace(/\s+(LLC|corporation|business company|limited)$/i, '').trim();
        if (head === 'British Virgin Islands') return 'BVI';
        return head && head.length <= 28 ? head : null;
    }

    /**
     * Who holds the freeze, pause and move-or-burn ("take") powers, from one stocks-power-map.json
     * issuer row: `{freeze, pause, take}` each `{kind, threshold, timelockSeconds}`. The bundle
     * builder passes these in; the page's no-bundle path has none and shows the powers without holders.
     */
    function buyerPowers(powerMapRow) {
        const cells = Array.isArray(powerMapRow?.cells) ? powerMapRow.cells : [];
        const pick = (id) => {
            const cell = cells.find((row) => row?.power === id);
            if (!cell) return null;
            return {
                kind: typeof cell.kind === 'string' ? cell.kind : 'unknown',
                threshold: typeof cell.signerThreshold === 'string' ? cell.signerThreshold : null,
                timelockSeconds: isNum(cell.timelock?.seconds) ? cell.timelock.seconds : null
            };
        };
        return { freeze: pick('freeze'), pause: pick('pause'), take: pick('moveBurn') };
    }

    function sameStockComparisonModels(group, issuersBySlug, defiByMint, composability, nowMs = Date.now(), { powersByIssuer = null } = {}) {
        const issuerMap = issuersBySlug instanceof Map ? issuersBySlug : new Map();
        const usageMap = defiByMint instanceof Map ? defiByMint : new Map();
        const powersMap = powersByIssuer instanceof Map ? powersByIssuer : new Map();
        return (Array.isArray(group?.rows) ? group.rows : []).map((row) => {
            const issuer = issuerMap.get(row.issuer) ?? {};
            const tokens = Array.isArray(row.tokens) ? row.tokens : [];
            const integrations = tokens.flatMap((token) => usageMap.get(token.mint)?.integrations ?? []);
            const template = aggregateComposabilityTemplates(composability, tokens);
            const outcome = lenderOutcomeModel(template, issuer, { integrations });
            const grades = issuer.grades ?? {};
            const verdict = laypersonVerdict({
                claimRung: grades.claimRung,
                redemptionAvailable: issuer.redemption?.available,
                control: issuer.control ?? {}
            });
            const review = legalReviewStatus(issuer);
            const observedSum = (field) => {
                const values = tokens.map((token) => token?.market?.[field]).filter(isNum);
                return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
            };
            const liquidityUsd = observedSum('liquidity');
            const volume24Usd = observedSum('vol24');
            const protocols = [...new Set(integrations.map((entry) => entry.protocolName || entry.protocolId).filter(Boolean))].sort();
            const decision = productDecisionProfile(issuer, tokens[0], integrations, template, nowMs);
            const redemptionUsability = redemptionUsabilitySummary(issuer, tokens[0] ?? null).model;
            return {
                issuerSlug: row.issuer,
                issuerName: issuer.name ?? humanizeSlug(row.issuer),
                tokens,
                verdict,
                rights: holderRightsRows(issuer.holderRights),
                review,
                outcome,
                protocols,
                decision,
                redemptionUsability,
                provenance: provenanceSummary(issuer),
                provenanceHtml: provenanceHtml(issuer, { compact: true }),
                liquidityUsd,
                volume24Usd,
                // The issuer facts the buyer table needs, small enough to ship in every bundle.
                buyer: {
                    // A pre-IPO wrapper (PreStocks, Tessera): no listed share, so the table prices it
                    // against the issuer's own mark and words its claim and redemption for that.
                    preIpo: tokens.length > 0 && tokens.every((token) => token?.instrumentType === 'private-company'),
                    claimRung: isNum(grades.claimRung) ? grades.claimRung : null,
                    claimLabel: typeof grades.claimLabel === 'string' ? grades.claimLabel : null,
                    legalForm: typeof issuer.legalForm === 'string' ? issuer.legalForm : null,
                    jurisdiction: shortJurisdiction(issuer.entityJurisdiction),
                    usPersonsExcluded: issuer.transferRestrictions?.usPersonsExcluded === true
                },
                powers: powersMap.get(row.issuer) ?? null
            };
        });
    }

    const DEBT_NOTE_FORMS = new Set(['tracker-certificate', 'structured-note', 'debt-note']);

    /**
     * What a pre-IPO token holder owns, by the issuer's legal form: the dossiers' holderClaim,
     * shortened (tested against the dossier wording). PreStocks (spv-synthetic): a token that
     * "reference[s] economic exposure to designated pre-IPO companies" with "no ownership" rights.
     * Tessera (structured-note): "an unsecured stablecoin-loan participation right ... repayable only
     * out of Liquidity Event Proceeds". Any other form falls back to the claim-depth words below.
     */
    const PRE_IPO_OWN = {
        'spv-synthetic': 'No shares: a token referencing the company’s value',
        'structured-note': 'Unsecured loan participation, repaid from sale proceeds'
    };

    /** "Secured debt note tracking the share (Jersey)": the claim-depth rung and legal form in plain words. */
    function ownWords(buyer) {
        const rung = buyer?.claimRung;
        const note = DEBT_NOTE_FORMS.has(buyer?.legalForm);
        // A pre-IPO note references a private company's value; there is no listed share to track.
        const tracks = buyer?.preIpo ? 'referencing the company' : 'tracking the share';
        const words = buyer?.preIpo && PRE_IPO_OWN[buyer?.legalForm] ? PRE_IPO_OWN[buyer.legalForm]
            : rung === 4 ? 'The registered share itself'
            : note && rung === 2 ? `Secured debt note ${tracks}`
                : note && rung === 1 ? `Unsecured debt note ${tracks}`
                    : rung === 3 ? 'Beneficial interest in pooled shares'
                        : rung === 0 ? 'Price exposure only, no claim on shares'
                            : buyer?.claimLabel ? buyer.claimLabel.charAt(0).toUpperCase() + buyer.claimLabel.slice(1)
                                : 'Not established';
        // A registered share is the company's own; the wrapper's home only matters for a claim on it.
        return rung !== 4 && buyer?.jurisdiction ? `${words} (${buyer.jurisdiction})` : words;
    }

    function installed(value) {
        return value === true || (typeof value === 'string' && value.trim() !== '');
    }

    function joinWords(words) {
        return words.length <= 1 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
    }

    /** "2-of-4 multisig", "one key (any 1 of 9)", "issuer program": who can use one power. */
    function holderText(holder) {
        if (!holder) return null;
        const [, m, n] = /^(\d+) of (\d+)/.exec(holder.threshold ?? '') ?? [];
        if (holder.kind === 'multisig') return m ? `${m}-of-${n} multisig` : 'multisig';
        if (holder.kind === 'single-key') return m ? `one key (any ${m} of ${n})` : 'one key';
        if (holder.kind === 'program') return 'issuer program';
        return 'holder not established';
    }

    function timelockText(seconds) {
        if (!isNum(seconds)) return null;
        if (seconds === 0) return 'no time lock';
        return seconds < 3600 ? `${Math.round(seconds / 60)} min time lock` : `${Math.round(seconds / 360) / 10} h time lock`;
    }

    /** Freeze, pause and take ("move or burn your tokens"), from the tokens' on-chain settings and the power map. */
    function powersCell(model) {
        const controls = model.tokens.map((token) => token?.control).filter((control) => control && typeof control === 'object');
        if (!controls.length) return { text: 'Not read', note: null, tone: 'muted' };
        const has = {
            freeze: controls.some((control) => installed(control.freezeAuthority)),
            pause: controls.some((control) => control.pausable === true),
            take: controls.some((control) => installed(control.permanentDelegate) || control.clawback === true)
        };
        const powers = ['freeze', 'pause', 'take'].filter((id) => has[id]);
        if (!powers.length) return { text: 'No', note: 'No freeze, pause or take power installed', tone: 'good' };
        const text = has.take ? `Yes: ${joinWords(powers)}` : `Yes: ${joinWords(powers)}; cannot take`;
        if (!model.powers) return { text, note: null, tone: 'caution' };
        // Powers held the same way are named once: "Freeze and pause: 2-of-4 multisig".
        const locks = new Set(powers.map((id) => timelockText(model.powers[id]?.timelockSeconds)));
        const oneLock = locks.size === 1 ? [...locks][0] : null;
        const groups = new Map();
        for (const id of powers) {
            const holder = holderText(model.powers[id]) ?? 'holder not established';
            const lock = oneLock === null ? timelockText(model.powers[id]?.timelockSeconds) : null;
            const key = lock ? `${holder}, ${lock}` : holder;
            groups.set(key, [...(groups.get(key) ?? []), id]);
        }
        const parts = [...groups].map(([holder, ids]) => `${joinWords(ids)}: ${holder}`);
        if (oneLock) parts.push(oneLock);
        const note = parts.join(' · ');
        return { text, note: note.charAt(0).toUpperCase() + note.slice(1), tone: 'caution' };
    }

    /** "PreStocks’", "Tessera’s": an issuer's name as a possessive. */
    function possessive(name) {
        return /s$/i.test(name) ? `${name}’` : `${name}’s`;
    }

    /**
     * A pre-IPO wrapper has no share price to compare with: the premium is against the issuer's own
     * published mark (reference source `issuer-mark`, read with the Jupiter price it was measured
     * against), and the note adds the valuation that mark implies (the issuer API's markValuation,
     * shown only when the API's markPrice is the same mark, so a valuation never sits beside another
     * reading's price).
     */
    function markPriceCell(model) {
        const token = model.tokens[0] ?? {};
        const price = token.market?.usdPrice;
        const fromMark = token.reference?.source === 'issuer-mark';
        const mark = fromMark ? token.reference.price : null;
        const premium = fromMark ? token.reference.premiumPct : null;
        const valuation = isNum(mark) && isNum(token.issuerApi?.markValuation)
            && Math.abs(token.issuerApi.markPrice - mark) <= Math.abs(mark) * 1e-9 ? token.issuerApi.markValuation : null;
        const prefix = model.tokens.length > 1 ? `${token.symbol}: ` : '';
        const note = [
            isNum(price) ? `${prefix}${fmtPrice(price)} on Jupiter` : null,
            isNum(mark) ? `mark ${fmtPrice(mark)}` : null,
            isNum(valuation) ? `values ${token.companyName || 'the company'} at ${fmtMoney(valuation)}` : null
        ].filter(Boolean).join(' · ') || null;
        if (isNum(premium)) {
            return { text: `${fmtSignedPct(premium)} vs ${possessive(model.issuerName)} own mark`, note, tone: Math.abs(premium) >= 2 ? 'caution' : null };
        }
        return { text: note ? 'Premium to the mark not measured' : 'Not measured', note, tone: 'muted' };
    }

    function priceCell(model) {
        if (model.buyer?.preIpo) return markPriceCell(model);
        const token = model.tokens[0] ?? {};
        const price = token.market?.usdPrice;
        const premium = token.reference?.premiumPct;
        const prefix = model.tokens.length > 1 ? `${token.symbol}: ` : '';
        const note = isNum(price) ? `${prefix}${fmtPrice(price)} on Jupiter` : null;
        if (isNum(premium)) {
            return { text: `${fmtSignedPct(premium)} vs ${token.underlyingTicker ?? 'the share'}`, note, tone: Math.abs(premium) >= 2 ? 'caution' : null };
        }
        return { text: note ? 'Premium not measured' : 'Not measured', note, tone: 'muted' };
    }

    function sumOf(values) {
        const list = values.filter(isNum);
        return list.length ? list.reduce((sum, value) => sum + value, 0) : null;
    }

    function liquidityCell(model) {
        const dexPairs = sumOf(model.tokens.map((token) => token?.activity?.dexPairs));
        const cexMarkets = sumOf(model.tokens.map((token) => token?.activity?.cexMarkets));
        // Named by source: DexScreener lists fewer pools than Jupiter's liquidity aggregates, so a
        // "0 pools" beside a Jupiter liquidity figure is not a contradiction once each is attributed.
        const venues = [
            dexPairs === null ? null : `DexScreener: ${dexPairs} pool${dexPairs === 1 ? '' : 's'}`,
            cexMarkets === null ? null : `CoinGecko: ${cexMarkets} exchange market${cexMarkets === 1 ? '' : 's'}`
        ].filter(Boolean);
        const note = venues.length ? venues.join(' · ') : null;
        if (!isNum(model.liquidityUsd) && !isNum(model.volume24Usd)) return { text: 'Not measured', note, tone: 'muted' };
        const liquidity = isNum(model.liquidityUsd) ? `${fmtMoney(model.liquidityUsd)} liquidity` : 'Liquidity not measured';
        const volume = isNum(model.volume24Usd) ? `${fmtMoney(model.volume24Usd)} traded 24 h` : 'volume not measured';
        return { text: `${liquidity} · ${volume}`, note, tone: null };
    }

    /** "$5,000" from "USD 5,000 per transaction…" / "$1" from "$1.00 USD…"; null when no amount is stated. */
    function firstMoney(text) {
        const match = /(?:US\$|USD\s?|\$)\s?(\d[\d,]*(?:\.\d+)?)/.exec(String(text ?? ''));
        if (!match) return null;
        const value = Number(match[1].replace(/,/g, ''));
        return Number.isFinite(value) ? `$${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : null;
    }

    function redeemCell(model) {
        const usability = model.redemptionUsability ?? {};
        if (usability.directRedemption !== true) {
            return { text: usability.directRedemption === false ? 'No' : 'Not established', note: 'Exit by selling the token', tone: 'caution' };
        }
        const field = (id) => (Array.isArray(usability.fields) ? usability.fields : []).find((row) => row.id === id) ?? null;
        if (model.buyer?.preIpo) {
            // The dossier's eligibility terms: Tessera redeems only after a Liquidity Event (the
            // issuer's "divestment of all interests" in the company); PreStocks' holder "may request
            // redemption - discretionary, not an entitlement", or be pointed at on-chain liquidity.
            const terms = String(field('eligibility-and-place')?.value ?? '');
            if (/\bliquidity event\b/i.test(terms)) {
                return { text: 'Only after a liquidity event', note: 'Paid when the issuer sells its whole stake; exit by selling until then', tone: 'caution' };
            }
            if (/\bdiscretion/i.test(terms)) {
                return { text: 'On request, at the issuer’s discretion', note: 'Not an entitlement; exit by selling', tone: 'caution' };
            }
        }
        const who = [field('kyc')?.value === true ? 'KYC’d' : null, model.buyer?.usPersonsExcluded ? 'non-US' : null].filter(Boolean);
        // A term counts only where it covers this exact token (a TSLAx fee is not an AAPLx fee).
        const minimum = field('minimum')?.applicable === true ? firstMoney(field('minimum').value) : null;
        const feeMatch = field('fees')?.applicable === true ? /up to (\d+(?:\.\d+)?)\s?%/i.exec(String(field('fees').value ?? '')) : null;
        const note = [minimum ? `Min ${minimum}` : null, feeMatch ? `fee up to ${feeMatch[1]}%` : null].filter(Boolean).join(' · ');
        return { text: who.length ? `Yes: ${who.join(' ')} holders` : 'Yes', note: note || null, tone: null };
    }

    function borrowCell(model) {
        const reads = model.tokens.map((token) => token?.closedMarket);
        const lenders = [];
        for (const list of reads.filter(Array.isArray)) {
            for (const lender of list) {
                const line = `${lender?.protocolName}: ${lender?.label}`;
                if (lender?.protocolName && lender?.label && !lenders.includes(line)) lenders.push(line);
            }
        }
        if (lenders.length) return { text: lenders.join(' · '), note: null, tone: null };
        // Only a closed-market file that was read can say no lender takes the token.
        if (reads.some((read) => !Array.isArray(read))) return { text: 'Not checked here', note: null, tone: 'muted' };
        return { text: 'No lender we track takes it', note: null, tone: 'muted' };
    }

    function feePct(bps) {
        return `${(bps / 100).toFixed(2)}%`;
    }

    function feeCell(model) {
        const control = model.tokens.map((token) => token?.control).find((row) => row && (isNum(row.transferFeeBps) || isNum(row.transferFeeScheduled?.bps)));
        if (!control) return { text: 'None', note: null, tone: null };
        const now = isNum(control.transferFeeBps) ? `${feePct(control.transferFeeBps)} now` : 'fee in effect not read';
        const scheduled = control.transferFeeScheduled;
        const next = isNum(scheduled?.bps) ? `; ${feePct(scheduled.bps)} scheduled` : '';
        const change = isNum(control.transferFeeBps) && isNum(scheduled?.bps) && scheduled.bps < control.transferFeeBps ? 'cut' : 'rise';
        const note = isNum(scheduled?.bps) && isNum(scheduled?.epoch) ? `The ${change} starts at Solana fee epoch ${scheduled.epoch}` : null;
        return { text: `${now}${next}`, note, tone: 'caution' };
    }

    function tokenCardHref(token, section = '') {
        return `./cards/${encodeURIComponent(token?.cardSlug || cardSlug(token?.symbol, token?.mint))}.html${section ? `#${section}` : ''}`;
    }

    /**
     * The buyer table's rows: what a buyer compares first, one short cell per wrapper, each linking
     * to the card section with the detail. Pure data; buyerTableHtml renders it. A transfer-fee row
     * appears only when some wrapper charges or has scheduled a fee.
     */
    function buyerRows(models) {
        const columns = Array.isArray(models) ? models.filter((model) => Array.isArray(model?.tokens)) : [];
        // Pre-IPO wrappers have no share price and no market close: those rows say what they compare.
        const preIpo = columns.filter((model) => model.buyer?.preIpo).length;
        const allPreIpo = preIpo > 0 && preIpo === columns.length;
        const price = allPreIpo ? ['Price vs the issuer’s mark', 'Premium or discount against the issuer’s own published mark; a private company has no share price.']
            : preIpo ? ['Price vs the stock or the issuer’s mark', 'Listed wrappers against the share’s reference price; pre-IPO wrappers against their issuer’s own mark.']
                : ['Price vs the stock', 'Premium or discount against the share’s reference price.'];
        const borrow = allPreIpo ? ['Borrow against it', 'Lenders we track that take this exact token.']
            : ['Borrow against it when the market is closed', 'The price each lender uses while the US market is shut.'];
        const charges = columns.some((model) => model.tokens.some((token) => {
            const control = token?.control ?? {};
            return (isNum(control.transferFeeBps) && control.transferFeeBps > 0) || (isNum(control.transferFeeScheduled?.bps) && control.transferFeeScheduled.bps > 0);
        }));
        const rows = [
            ['own', 'What you own', 'The legal claim, with the issuer’s home in brackets.', 'own',
                (model) => ({ text: ownWords(model.buyer), note: null, tone: null })],
            ['powers', 'Can the issuer freeze or take your tokens?', 'From the token’s on-chain settings; who holds each key.', 'control', powersCell],
            ['rights', 'Shareholder rights', '✓ yours · ◐ passed through · ◌ at the issuer’s discretion · ✕ no · ? not stated', 'holder-rights',
                (model) => ({ text: holderRightsHeadline(model.rights), note: null, tone: null, rights: model.rights ?? [] })],
            ['price', ...price, 'reference', priceCell],
            ['liquidity', 'Liquidity and where to trade', 'DEX liquidity (Jupiter, all pools) and 24 h volume.', 'depth', liquidityCell],
            ['redeem', 'Redeem with the issuer', 'Who may, and the minimum and fee where set for this token.', 'own', redeemCell],
            ['borrow', ...borrow, 'closed-market', borrowCell],
            ...(charges ? [['fee', 'Transfer fee', 'Charged on-chain on every transfer.', 'control', feeCell]] : [])
        ];
        return rows.map(([id, label, help, section, cell]) => ({
            id, label, help,
            cells: columns.map((model) => ({ ...cell(model), href: tokenCardHref(model.tokens[0], section) }))
        }));
    }

    /** The buyer table, above the Decision summary: no disclosure to open, and it scrolls on its own on a phone. */
    function buyerTableHtml(models, { sources = null } = {}) {
        const columns = Array.isArray(models) ? models.filter((model) => Array.isArray(model?.tokens) && model.tokens.length) : [];
        if (!columns.length) return '';
        const rows = buyerRows(columns);
        const header = columns.map((model) => `<th scope="col"><span class="buyer-tokens">${model.tokens.map((token) =>
            `<a href="${escapeHtml(tokenCardHref(token))}">${escapeHtml(token.symbol || mintSuffix(token.mint))}</a>`).join(' · ')}</span>`
            + `<a class="issuer-link" href="${escapeHtml(issuerDossierHref(model.issuerSlug))}">${escapeHtml(model.issuerName)}</a>`
            + `${model.buyer?.preIpo ? '<span class="buyer-kind">Pre-IPO</span>' : ''}</th>`).join('');
        const cellHtml = (cell) => {
            const tone = cell.tone ? ` class="buyer-${escapeHtml(cell.tone)}"` : '';
            if (cell.rights) return `<td${tone}>${holderRightsStripHtml(cell.rights, { href: cell.href })}</td>`;
            return `<td${tone}><a class="buyer-link" href="${escapeHtml(cell.href)}">${escapeHtml(cell.text)}</a>`
                + `${cell.note ? `<small>${escapeHtml(cell.note)}</small>` : ''}</td>`;
        };
        const body = rows.map((row) => `<tr data-row="${escapeHtml(row.id)}"><th scope="row"><strong>${escapeHtml(row.label)}</strong><small>${escapeHtml(row.help)}</small></th>`
            + row.cells.map(cellHtml).join('') + '</tr>').join('');
        const read = [
            sources?.marketFetchedAt ? `Market read ${fmtDateTime(sources.marketFetchedAt)}` : null,
            sources?.referencePricesFetchedAt ? `premium read ${fmtDateTime(sources.referencePricesFetchedAt)}` : null,
            sources?.closedMarketAt ? `lenders read ${fmtDateTime(sources.closedMarketAt)}` : null
        ].filter(Boolean).join(' · ');
        return `<section class="buyer-table" aria-labelledby="buyerTableTitle"><header><h2 id="buyerTableTitle">Before you buy</h2>`
            + `<small>${columns.length === 1 ? 'The facts a buyer checks first.' : 'The facts that differ most, side by side.'} Each answer links to the card with the detail.${read ? ` ${escapeHtml(read)}.` : ''}</small>`
            // Two wrappers fit a phone; more scroll inside the frame, and past five on any screen.
            + (columns.length > 2 ? `<small class="buyer-hint${columns.length > 5 ? ' buyer-hint-wide' : ''}">Scroll the table sideways to see all ${columns.length} wrappers.</small>` : '')
            + '</header>'
            + `<div class="buyer-wrap" tabindex="0" role="region" aria-label="Buyer facts for each wrapper">`
            + `<table class="buyer-grid" style="--buyer-cols:${columns.length}"><thead><tr><td></td>${header}</tr></thead><tbody>${body}</tbody></table></div></section>`;
    }

    const CONCEPT_GUIDES = {
        claim: { href: './learn/beneficial-ownership.html', label: 'How the claim-depth ladder works' },
        ownership: { href: './learn/beneficial-ownership.html', label: 'How token ownership differs from owning the share' },
        insolvency: { href: './learn/bankruptcy-remoteness.html', label: 'How the claim behaves if an issuer fails' },
        redemption: { href: './learn/redemption.html', label: 'What makes a redemption route usable' },
        control: { href: './learn/issuer-control.html', label: 'How freeze and forced-transfer powers work' },
        defi: { href: './learn/defi-custody.html', label: 'Why custody may not create enforceable collateral' }
    };

    function conceptHelpHtml(id, prefix = 'What does this mean?') {
        const guide = CONCEPT_GUIDES[id];
        if (!guide) return '';
        return `<a class="context-help" href="${escapeHtml(guide.href)}"><span>${escapeHtml(prefix)}</span>${escapeHtml(guide.label)} →</a>`;
    }

    function conceptGuideRowHtml(ids) {
        return `<nav class="concept-guide-row" aria-label="Explain these concepts">${(Array.isArray(ids) ? ids : [])
            .map((id) => conceptHelpHtml(id, 'Learn')).join('')}</nav>`;
    }

    /** A wrapper's statuses for only the rights that differ between the wrappers compared. */
    function rightsText(rows, ids) {
        const list = (Array.isArray(rows) ? rows : []).filter((row) => ids.has(row.id));
        return list.map((row) => `${row.label}: ${row.statusLabel.toLowerCase()}`).join(' · ');
    }

    /** Only the decision-relevant fields whose values genuinely differ across same-stock wrappers. */
    function comparisonDifferenceRows(models) {
        const rows = Array.isArray(models) ? models : [];
        const differing = new Set((rows[0]?.rights ?? []).map((right) => right.id)
            .filter((id) => new Set(rows.map((model) => (model.rights ?? []).find((right) => right.id === id)?.status)).size > 1));
        const fields = [
            ['ownership', 'Legal claim', (model) => model.verdict?.ownership],
            ['redemption', 'Cash exit', (model) => model.outcome?.cashExit],
            ['control', 'Issuer intervention', (model) => model.verdict?.controlNote],
            ['defi', 'Collateral exit', (model) => `${model.outcome?.exitQuality?.label}: ${model.outcome?.exitQuality?.reason}`],
            ['defi', 'Listed by a DeFi protocol', (model) => model.outcome?.confirmedLending],
            ['insolvency', 'Evidence status', (model) => `${model.review?.label}: ${model.review?.detail}`],
            ['ownership', 'Shareholder rights', (model) => rightsText(model.rights, differing)]
        ];
        return fields.map(([concept, label, value]) => ({
            concept, label,
            values: rows.map((model) => ({ issuer: model.issuerName, value: String(value(model) ?? 'Unknown') }))
        })).filter((row) => new Set(row.values.map((entry) => entry.value)).size > 1);
    }

    function sameStockComparisonHtml(group, models, { sources = null } = {}) {
        const columns = Array.isArray(models) ? models : [];
        if (!group || columns.length === 0) return '';
        const outcome = (entry, status) => `<span class="comparison-verdict comparison-verdict-${escapeHtml(status)}">${escapeHtml(entry?.headline ?? 'Unknown')}</span>` +
            `<small>${escapeHtml(entry?.explanation ?? '')}</small>`;
        const questions = [
            ['What do you own?', 'The legal claim—not the ticker on the token.', 'legal-conclusion', (model) => `<strong>${escapeHtml(model.verdict.ownership)}</strong><small>${escapeHtml(model.verdict.cooperation)}</small>`, 'ownership'],
            ['Shareholder rights', 'Which rights of the share reach the token holder: ✓ as a shareholder, ◐ passed through by the issuer, ◌ only if the issuer decides, ✕ no, ? not stated. Details are on each token card.', 'legal-conclusion', (model) => holderRightsStripHtml(model.rights, { href: model.tokens[0] ? `./cards/${encodeURIComponent(model.tokens[0].cardSlug || cardSlug(model.tokens[0].symbol, model.tokens[0].mint))}.html#holder-rights` : null }), 'ownership'],
            ['Primary dependency', 'The structural dependency that could make the token diverge from the stock.', 'legal-conclusion', (model) => `<strong>${escapeHtml(model.verdict.mainFailure)}</strong>`, 'insolvency'],
            ['Redeem for cash', 'Whether seizure can become money without finding another buyer.', 'legal-conclusion', (model) => `<span class="comparison-verdict comparison-verdict-${escapeHtml(model.outcome.status)}">${escapeHtml(model.outcome.cashExit)}</span>`, 'redemption'],
            ['Smart-contract custody', 'Can an unstaffed protocol account hold and later release it?', 'analysis', (model) => outcome(model.outcome.custody, model.outcome.status), 'defi'],
            ['Borrower default', 'Can the lender seize and dispose of the collateral by code?', 'analysis', (model) => outcome(model.outcome.default, model.outcome.status), 'defi'],
            ['Exit after default', 'Bottom line: can seized collateral become usable value?', 'analysis', (model) => `<span class="comparison-verdict comparison-exit-${escapeHtml(model.outcome.exitQuality.rating)}">${escapeHtml(model.outcome.exitQuality.label)}</span><small>${escapeHtml(model.outcome.exitQuality.reason)}</small>`, 'defi'],
            ['Listed as loan collateral', 'This exact token in a lending protocol\'s own live list of accepted collateral; a listing does not prove a loan works.', 'source-listing', (model) => `<strong>${escapeHtml(model.outcome.confirmedLending)}</strong>${model.protocols.length ? `<small>All source-listed uses: ${escapeHtml(model.protocols.join(', '))}</small>` : ''}`, 'defi'],
            ['Secondary-market exit', 'A pool is an exit path, not a promise of executable size.', 'confirmed-fact', (model) => `<strong>${escapeHtml(fmtMoney(model.liquidityUsd))} reported liquidity</strong><small>${escapeHtml(fmtMoney(model.volume24Usd))} reported 24 h volume. ${escapeHtml(model.outcome.marketExit)}</small>`, 'redemption'],
            ['If the protocol is hacked', 'Whether issuer powers may help—and may override finality.', 'analysis', (model) => outcome(model.outcome.hack, model.outcome.status), 'control'],
            ['If access is lost', 'What happens when the contract or controlling key is inaccessible?', 'analysis', (model) => outcome(model.outcome.accessLoss, model.outcome.status), 'defi'],
            ['Evidence status', 'A conclusion is only as good as the documents behind it.', 'evidence-status', (model) => `<span class="review-status ${model.review.pending ? 'review-pending' : 'review-complete'}">${escapeHtml(model.review.label)}</span><small>${escapeHtml(model.review.detail)}</small>`, 'insolvency']
        ];
        const tokenLinks = (model) => model.tokens.map((token) => `<a href="./cards/${encodeURIComponent(token.cardSlug || cardSlug(token.symbol, token.mint))}.html">${escapeHtml(token.symbol || mintSuffix(token.mint))}</a>`).join(' · ');
        const header = columns.map((model) => `<th scope="col"><a class="issuer-link" href="${escapeHtml(issuerDossierHref(model.issuerSlug))}">${escapeHtml(model.issuerName)}</a>` +
            `<span class="comparison-token-links">${tokenLinks(model)}</span></th>`).join('');
        const body = questions.map(([label, help, kind, render]) => `<tr data-evidence-kind="${escapeHtml(kind)}"><th scope="row"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(help)}</span><em class="evidence-kind evidence-kind-${escapeHtml(kind)}">${escapeHtml(humanizeSlug(kind))}</em></th>`
            + columns.map((model) => `<td>${render(model)}</td>`).join('') + '</tr>').join('');
        const ownerships = new Set(columns.map((model) => model.verdict.ownership));
        const differences = comparisonDifferenceRows(columns);
        const standalone = columns.length === 1;
        const decision = standalone ? columns[0].verdict.ownership
            : differences.length ? `${differences[0].label}: what changes between wrappers`
                : 'No headline difference is established in the selected evidence. That does not make these wrappers interchangeable.';
        const productCards = columns.map((model) => `<article class="comparison-product-card"><header><a class="issuer-link" href="${escapeHtml(issuerDossierHref(model.issuerSlug))}">${escapeHtml(model.issuerName)}</a><span>${model.tokens.length} token${model.tokens.length === 1 ? '' : 's'}</span></header>`
            + `<p><strong>Own</strong>${escapeHtml(model.verdict.ownership)}</p><div class="comparison-rights"><strong>Shareholder rights</strong>${holderRightsStripHtml(model.rights)}</div><p><strong>Cash exit</strong>${escapeHtml(model.outcome.cashExit)}</p>`
            + `<p><strong>DeFi now</strong>${escapeHtml(model.outcome.confirmedLending)}</p><p><strong>Main dependency</strong>${escapeHtml(model.verdict.mainFailure)}</p>`
            + `<nav class="comparison-token-links" aria-label="Exact token reports">${tokenLinks(model)}</nav>${model.provenanceHtml}</article>`).join('');
        const questionCards = questions.map(([label, help, kind, render, concept]) => `<details class="comparison-question"><summary><span><strong>${escapeHtml(label)}</strong><small>${escapeHtml(help)}</small></span><em class="evidence-kind evidence-kind-${escapeHtml(kind)}">${escapeHtml(humanizeSlug(kind))}</em></summary><div>`
            + columns.map((model) => `<article><h4>${escapeHtml(model.issuerName)}</h4>${render(model)}</article>`).join('') + `</div>${conceptHelpHtml(concept)}</details>`).join('');
        const renderDifferenceValues = (row) => {
            // Group genuinely identical answers once, even when many tokenizers offer the stock.
            const values = new Map();
            for (const entry of row.values) values.set(entry.value, [...(values.get(entry.value) ?? []), entry.issuer]);
            return `<dl>${[...values].map(([value, names]) => `<div><dt>${names.length > 3 ? `<details><summary>${names.length} wrappers</summary>${escapeHtml(names.join(' · '))}</details>` : escapeHtml(names.join(' · '))}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>`;
        };
        const renderDifference = (row) => `<article><div><h3>${escapeHtml(row.label)}</h3>${conceptHelpHtml(row.concept)}</div>${renderDifferenceValues(row)}</article>`;
        const differenceHtml = !standalone && differences.length > 1
            ? `<details class="comparison-differences"><summary>What actually differs · ${differences.length - 1} more difference${differences.length === 2 ? '' : 's'}</summary>${differences.slice(1).map(renderDifference).join('')}</details>` : '';
        return buyerTableHtml(columns, { sources }) +
            `<div class="comparison-summary"><span>${columns.length} issuer structure${standalone ? '' : 's'} · exact-token support and legal outcomes shown separately</span></div>` +
            `<div class="comparison-decision"><span>${standalone ? 'Standalone answer' : 'Decision summary'}</span><strong>${escapeHtml(decision)}</strong>${!standalone && differences.length ? renderDifferenceValues(differences[0]) : ''}${!standalone && ownerships.size === 1 ? `<details class="comparison-shared-claim"><summary>Shared legal claim</summary><p>${escapeHtml(columns[0].verdict.ownership)}</p></details>` : ''}<small>${standalone ? 'This report remains useful without a competing wrapper.' : 'No universally “best” product is implied.'} Eligibility and intended use still matter.</small></div>` +
            differenceHtml + `<details class="comparison-research"${standalone ? ' open' : ''}><summary>Ownership and exit for ${standalone ? 'this wrapper' : 'each wrapper'}</summary><div class="comparison-product-grid">${productCards}</div></details>` +
            `<details class="comparison-research"><summary>Explore custody, default and evidence questions</summary><div class="comparison-question-list">${questionCards}</div></details>` +
            `<details class="full-comparison"><summary>Open the full research matrix</summary><p>Every selected wrapper is included. Scroll across the table for larger comparisons.</p><div class="table-wrap comparison-wrap" tabindex="0" role="region" aria-label="All selected wrapper research"><table class="comparison-table comparison-matrix"><thead><tr><th>Question</th>${header}</tr></thead><tbody>${body}</tbody></table></div></details>` +
            '<details class="comparison-research"><summary>How to read the evidence labels</summary><p class="comparison-note"><span class="evidence-kind evidence-kind-confirmed-fact">Confirmed fact</span> identifies the specific registry, account or market observation—not proof of a successful transaction. <span class="evidence-kind evidence-kind-issuer-claim">Issuer claim</span> is attributed but not independently established. <span class="evidence-kind evidence-kind-legal-conclusion">Legal conclusion</span> applies the reviewed documents. <span class="evidence-kind evidence-kind-analysis">Analysis / inference</span> combines those facts. <span class="evidence-kind evidence-kind-unknown">Unknown</span> never means “no”.</p></details>';
    }

    function filterComparisonModels(models, selectedIssuers, activeFilters) {
        // An explicit empty selection means none, not all. Omitting selection means every wrapper.
        const selected = selectedIssuers instanceof Set ? selectedIssuers : null;
        const filters = activeFilters instanceof Set ? activeFilters : new Set();
        return (Array.isArray(models) ? models : []).filter((model) => {
            if (selected && !selected.has(model.issuerSlug)) return false;
            return [...filters].every((key) => model.decision?.[key] === true);
        });
    }

    /** The requirement checkboxes stocks.html offers, in their on-page order — the order a URL writes them in. */
    const COMPARISON_REQUIREMENTS = ['cashRedemption', 'noDiscretionaryFreeze', 'confirmedCollateral',
        'autonomousLiquidation', 'segregatedAssets', 'nonUsHolders', 'freshEvidence'];

    /** `?requires=a,b` -> Set of known requirement keys. Unknown or repeated keys are dropped, so a typo filters nothing. */
    function parseComparisonRequirements(value) {
        const wanted = new Set(String(value ?? '').split(',').map((piece) => piece.trim()));
        return new Set(COMPARISON_REQUIREMENTS.filter((key) => wanted.has(key)));
    }

    /** The `requires` value that reproduces a set of requirements, in page order; '' when none is active. */
    function comparisonRequirementsParam(active) {
        const set = active instanceof Set ? active : new Set(Array.isArray(active) ? active : []);
        return COMPARISON_REQUIREMENTS.filter((key) => set.has(key)).join(',');
    }

    /**
     * Which underlying a compare URL asks for: `compare=` first, else a `search=` that is exactly a
     * ticker in the list (so `?view=compare&search=NVDA` opens NVDA, not the first group), else null
     * for the caller's default. Case-insensitive, and never a ticker the list does not contain.
     * `aliases` (discovery.js comparisonKeyAliases) lets a pre-IPO company be named by its name or a
     * wrapper symbol: `compare=SPACEX` and `compare=tOpenAI` open SPCX and OPENAI.
     */
    function comparisonTickerFromParams(params, tickers, aliases = null) {
        const known = new Set((Array.isArray(tickers) ? tickers : []).map((ticker) => String(ticker)));
        for (const key of ['compare', 'search']) {
            const value = params?.get?.(key)?.trim().toUpperCase();
            if (!value) continue;
            if (known.has(value)) return value;
            const alias = aliases instanceof Map ? aliases.get(value.replace(/[^A-Z0-9]/g, '')) : null;
            if (alias && known.has(alias)) return alias;
        }
        return null;
    }

    /** What the compare view calls a group: its ticker, or a pre-IPO company's name ("OpenAI (pre-IPO)"). */
    function comparisonGroupTitle(group) {
        return group?.preIpo ? `${group.name || group.ticker} (pre-IPO)` : String(group?.ticker ?? '');
    }

    /** Stable URL-safe filename shared with the scoped builder; ticker punctuation cannot escape it. */
    function comparisonBundleFilename(ticker) {
        const value = String(ticker ?? '').trim().toUpperCase();
        return value ? `u-${Array.from(value).map((letter) => letter.codePointAt(0).toString(16)).join('-')}.json` : null;
    }

    /** Reject mixed-release bundles instead of showing a convincing but incomplete comparison. */
    function comparisonBundleMatches(bundle, group, catalogueBuiltAt = null) {
        if (bundle?.schemaVersion !== 1 || bundle.ticker !== group?.ticker || !Array.isArray(bundle.models)) return false;
        if (catalogueBuiltAt && bundle.builtAt !== catalogueBuiltAt) return false;
        const expected = (group.rows ?? []).flatMap((row) => (row.tokens ?? []).map((token) => `${row.issuer}:${token.mint}`)).sort();
        const actual = bundle.models.flatMap((model) => (model.tokens ?? []).map((token) => `${model.issuerSlug}:${token.mint}`)).sort();
        return expected.length > 0 && expected.length === actual.length && expected.every((key, index) => key === actual[index]);
    }

    return {
        sameStockComparisonModels,
        shortJurisdiction,
        buyerPowers,
        buyerRows,
        buyerTableHtml,
        CONCEPT_GUIDES,
        conceptHelpHtml,
        conceptGuideRowHtml,
        comparisonDifferenceRows,
        sameStockComparisonHtml,
        filterComparisonModels,
        COMPARISON_REQUIREMENTS,
        parseComparisonRequirements,
        comparisonRequirementsParam,
        comparisonTickerFromParams,
        comparisonGroupTitle,
        comparisonBundleFilename,
        comparisonBundleMatches
    };
});
