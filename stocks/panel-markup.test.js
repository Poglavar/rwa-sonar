// Unit tests for stocks/lib/panel-markup.js: the small markup builders of the issuer cards and the
// issuer and token detail panels. They were inner functions of stocks.js's page closure with no
// tests of their own; they moved out verbatim (next-steps.md F11) and these pin what they print.
const {
    badge, metric, verificationBarHtml, keyGovernanceSummary, freezeExercisedLabel, freezeExercisedClass,
    detailSection, redemptionAnswerHtml, redemptionAnswer, linkHtml, detailList, controlValue, personalListHtml
} = require('./lib/panel-markup.js');

describe('card badges and metrics', () => {
    it('prints a control badge with its label, value and tooltip, escaped', () => {
        expect(badge('Freeze', 'all', 'cov-all', 'Every token can be frozen'))
            .toBe('<span class="ctl-badge cov-all" title="Every token can be frozen">'
                + '<span class="ctl-badge-label">Freeze</span><span class="ctl-badge-value">all</span></span>');
        expect(badge('<b>', '"x"', 'c', '<t>')).not.toMatch(/<b>|"x"|<t>/);
    });

    it('prints a metric row, with a tooltip only when there is one', () => {
        expect(metric('Liquidity', '$1.2M')).toBe('<div class="metric"><dt>Liquidity</dt><dd>$1.2M</dd></div>');
        expect(metric('Liquidity', '$1.2M', 'DEX reserves')).toContain('<div class="metric" title="DEX reserves">');
    });

    it('fills the verification bar up to the strength, capped at five, and dashes an unknown one', () => {
        const three = verificationBarHtml(3);
        expect(three.match(/ver-cell-on/g)).toHaveLength(3);
        expect(three.match(/class="ver-cell/g)).toHaveLength(5);
        expect(three).toContain('aria-label="Verification strength 3 of 5"');
        expect(three).toContain('<span class="ver-number">3/5</span>');
        expect(verificationBarHtml(9).match(/ver-cell-on/g)).toHaveLength(5);
        const unknown = verificationBarHtml(null);
        expect(unknown).not.toContain('ver-cell-on');
        expect(unknown).toContain('Verification strength unknown of 5');
        expect(unknown).toContain('<span class="ver-number">—/5</span>');
    });
});

describe('keyGovernanceSummary', () => {
    it('says a uniform governance once and a mixed one per role, in the §2.7 order', () => {
        expect(keyGovernanceSummary({ mint: 'multisig', freeze: 'multisig', delegate: 'multisig', rebase: 'multisig' }))
            .toBe('multisig');
        expect(keyGovernanceSummary({ mint: 'multisig', freeze: 'hot-key', delegate: 'none', rebase: 'program' }))
            .toBe('m:multisig f:hot key d:none r:program');
        // Three of four known is not "all the same": the missing role must not be implied.
        expect(keyGovernanceSummary({ mint: 'multisig', freeze: 'multisig', delegate: 'multisig' }))
            .toBe('m:multisig f:multisig d:multisig');
    });

    it('dashes an absent or empty record and keeps an unrecognised value as written', () => {
        expect(keyGovernanceSummary(null)).toBe('—');
        expect(keyGovernanceSummary({})).toBe('—');
        expect(keyGovernanceSummary({ mint: 'timelock' })).toBe('m:timelock');
    });
});

describe('freeze-exercised wording', () => {
    it('reads yes as a fact and anything missing as unknown', () => {
        expect(freezeExercisedLabel('yes')).toBe('yes');
        expect(freezeExercisedLabel(null)).toBe('unknown');
        expect(freezeExercisedLabel(undefined)).toBe('unknown');
        expect(freezeExercisedLabel('no')).toBe('no');
        expect(freezeExercisedClass('yes')).toBe('cov-all');
        expect(freezeExercisedClass('no')).toBe('cov-unknown');
    });
});

describe('detail sections and lists', () => {
    it('drops a section with no fields and keeps one that has any', () => {
        expect(detailSection('Redemption', ['', null, false])).toBe('');
        expect(detailSection('Redemption', ['<div>a</div>', ''])).toBe(
            '<section class="detail-section"><h4>Redemption</h4><dl class="detail-fields"><div>a</div></dl></section>');
    });

    it('says "None recorded." for an empty list and counts a full one', () => {
        expect(detailList('Documents', [], String)).toContain('<p class="detail-empty">None recorded.</p>');
        expect(detailList('Documents', null, String)).toContain('None recorded.');
        const html = detailList('Documents', ['a', '', 'b'], (item) => `<i>${item}</i>`);
        expect(html).toContain('<span class="detail-count">3</span>');
        expect(html).toContain('<ul class="detail-list"><li><i>a</i></li><li><i>b</i></li></ul>');
    });

    it('lists saved items, or says why the list is empty', () => {
        expect(personalListHtml([], 'Nothing saved <yet>')).toBe('<p class="personal-empty">Nothing saved &lt;yet&gt;</p>');
        expect(personalListHtml(['<li>A</li>'], 'x')).toBe('<ul class="personal-list"><li>A</li></ul>');
    });

    it('links only a safe URL, and opens it in a new tab', () => {
        expect(linkHtml('https://example.com/a')).toBe(
            '<a href="https://example.com/a" target="_blank" rel="noopener noreferrer">https://example.com/a</a>');
        expect(linkHtml('javascript:alert(1)')).toBe('');
        expect(linkHtml(null)).toBe('');
    });
});

describe('redemption answers', () => {
    const model = { fields: [{ id: 'route-currently-available', value: true, evidence: 'documented' }] };

    it('finds an answer by id, or null', () => {
        expect(redemptionAnswer(model, 'route-currently-available')).toBe(model.fields[0]);
        expect(redemptionAnswer(model, 'nope')).toBeNull();
        expect(redemptionAnswer(null, 'x')).toBeNull();
    });

    it('prints yes, no and unknown with the evidence state, and keeps the full terms expandable', () => {
        expect(redemptionAnswerHtml(null)).toBe('<strong>Unknown</strong><small class="evidence-state">Unknown</small>');
        expect(redemptionAnswerHtml({ value: true, evidence: 'documented' }))
            .toBe('<strong>Yes</strong><small class="evidence-state">Documented</small>');
        expect(redemptionAnswerHtml({ value: false })).toContain('<strong>No</strong>');
        const full = redemptionAnswerHtml({
            value: 'conditional', summary: 'KYC required', completeText: 'Only verified <holders>.',
            scopeContext: { holders: 'professional investors', jurisdictions: 'EU' }, evidence: 'issuer-claim'
        });
        expect(full).toContain('<details class="redemption-term"><summary>KYC required</summary>');
        expect(full).toContain('<p>Only verified &lt;holders&gt;.</p>');
        expect(full).toContain('<small>Holder scope: professional investors · Jurisdiction scope: EU</small>');
        expect(full).toContain('<small class="evidence-state">Issuer claim</small>');
    });
});

describe('controlValue', () => {
    it('reads an authority address as on, exactly as MODEL §3.3 does', () => {
        expect(controlValue(true)).toBe('yes');
        expect(controlValue(false)).toBe('no');
        expect(controlValue('  Auth1111  ')).toBe('yes · Auth1111');
        expect(controlValue('')).toBeNull();
        expect(controlValue(null)).toBeNull();
    });
});
