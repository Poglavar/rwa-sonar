// Public registry metadata and NAV observations are not custody or reserve assurance.
export function superstateFund(body) {
    const p = body?.USTB;
    if (p?.instrument_symbol !== 'USTB' || typeof p.instrument_name !== 'string' || !/^\d+(?:\.\d+)?$/.test(p.total_supply ?? '')) throw new Error('Malformed USTB instrument registry');
    const chains = p.deploy_status_by_chain?.by_chain;
    if (!chains || !Object.keys(chains).length) throw new Error('Missing USTB deployments');
    const deployments = Object.fromEntries(Object.entries(chains).filter(([, d]) => d.type === 'Completed').map(([id, d]) => {
        if (typeof d.token_address !== 'string' || !d.token_address) throw new Error('Missing completed deployment address');
        return [id, d.token_address];
    }));
    const price = p.current_price;
    if (price !== null && price !== undefined && !/^\d+(?:\.\d+)?$/.test(String(price))) throw new Error('Malformed registry price');
    return { decoderVersion: 1, fields: { name: { state: 'observed', value: p.instrument_name }, deployments: { state: 'observed', value: deployments }, supplyRaw: { state: 'observed', value: p.total_supply }, price: { state: price == null ? 'unknown' : 'observed', value: price ?? null } }, sourcePeriod: null,
        limitations: 'Instrument registry and reported supply only. No reserve assurance. Configuration updated_at is not a NAV or holdings timestamp.' };
}
export function decodeNav(round, decimals, nowSeconds) {
    if (typeof round !== 'string' || !/^0x[0-9a-fA-F]{320}$/.test(round) || typeof decimals !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(decimals)) throw new Error('Malformed NAV oracle response');
    const values = Array.from({ length: 5 }, (_, i) => BigInt('0x' + round.slice(2 + i * 64, 66 + i * 64)));
    const [id, answer, started, updated, answered] = values;
    const precision = BigInt(decimals);
    if (!id || !answer || answer >= 2n ** 255n || !updated || started > updated || answered < id || updated > BigInt(nowSeconds) || precision > 36n) throw new Error('Invalid NAV round');
    const sourcePeriod = new Date(Number(updated) * 1000).toISOString();
    return { decoderVersion: 1, fields: { navRaw: { state: 'observed', value: answer.toString() }, decimals: { state: 'observed', value: precision.toString() } }, sourcePeriod,
        evidenceStatus: nowSeconds - Number(updated) > 7 * 86400 ? 'stale' : 'recent', limitations: 'Published fund NAV only; seven-day freshness threshold allows weekends. No reserve, liquidity or redemption guarantee.' };
}
