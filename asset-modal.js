
document.addEventListener('DOMContentLoaded', () => {
    // State
    let attestationsData = [];
    let currentAsset = null;
    let lens = {
        attestors: new Set(),
        onchain: 'all',
        chain: 'all'
    };

    // Constants
    const TOKEN_STANDARDS = {
        'ERC-20': 'https://ethereum.org/en/developers/docs/standards/tokens/erc-20/',
        'ERC-721': 'https://ethereum.org/en/developers/docs/standards/tokens/erc-721/',
        'SPL': 'https://spl.solana.com/token',
        'SToken-2022': 'https://spl.solana.com/token-2022'
    };

    // DOM Elements
    const assetModal = document.getElementById('assetModal');
    const attestationModal = document.getElementById('attestationModal');
    const closeAssetBtn = document.getElementById('closeAssetBtn');
    const closeAssetOverlay = document.getElementById('closeAssetOverlay');
    const closeAttestationBtn = document.getElementById('closeAttestationBtn');
    const closeAttestationOverlay = document.getElementById('closeAttestationOverlay');

    const tokenCard = document.getElementById('tokenCard');
    const modalAssetImage = document.getElementById('modalAssetImage');
    const modalChainImage = document.getElementById('modalChainImage');
    const modalTokenStandard = document.getElementById('modalTokenStandard');

    const lensTags = document.getElementById('lensTags');
    const addAttestorBtn = document.getElementById('addAttestorBtn');
    const attestorDropdown = document.getElementById('attestorDropdown');

    const onchainSelect = document.getElementById('onchainSelect');
    const chainSelect = document.getElementById('chainSelect');

    // Load Data
    fetch('attestations-db.json')
        .then(r => r.json())
        .then(data => {
            attestationsData = data;
        })
        .catch(err => console.error("Failed to load attestations:", err));

    // Event Delegation for Asset Table
    document.addEventListener('click', (e) => {
        const tr = e.target.closest('tr');
        if (!tr) return;
        if (tr.cells.length < 2) return;
        if (e.target.closest('a')) return;

        const headers = Array.from(document.querySelectorAll('th'));
        const nameIndex = headers.findIndex(th => th.getAttribute('data-key') === 'name');

        if (nameIndex === -1) return;
        const nameCell = tr.cells[nameIndex];
        if (!nameCell) return;

        let rawText = nameCell.textContent.trim();

        fetch('rwa-assets-db.json')
            .then(r => r.json())
            .then(assets => {
                const match = assets.find(a => rawText.includes(a.name) || (a.ticker && rawText.includes(a.ticker)));
                if (match) {
                    openAssetModal(match);
                }
            });
    });

    // Modal Interaction
    function closeModal() {
        assetModal.style.display = 'none';
        assetModal.setAttribute('aria-hidden', 'true');
        currentAsset = null;
    }

    if (closeAssetBtn) closeAssetBtn.addEventListener('click', closeModal);
    if (closeAssetOverlay) closeAssetOverlay.addEventListener('click', closeModal);

    function closeAttModal() {
        attestationModal.style.display = 'none';
        attestationModal.setAttribute('aria-hidden', 'true');
    }
    if (closeAttestationBtn) closeAttestationBtn.addEventListener('click', closeAttModal);
    if (closeAttestationOverlay) closeAttestationOverlay.addEventListener('click', closeAttModal);

    // Lens Interaction
    if (addAttestorBtn) {
        addAttestorBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            populateAttestorDropdown();
            attestorDropdown.style.display = attestorDropdown.style.display === 'none' ? 'block' : 'none';
        });
    }

    document.addEventListener('click', (e) => {
        if (attestorDropdown && !e.target.closest('.lens-add-wrapper')) {
            attestorDropdown.style.display = 'none';
        }
    });

    if (onchainSelect) {
        onchainSelect.addEventListener('change', () => {
            lens.onchain = onchainSelect.value;
            renderCircles();
        });
    }

    // Core Functions
    function openAssetModal(asset) {
        currentAsset = asset;

        // Setup Asset Card
        modalAssetImage.src = asset.asset_image || '';
        modalChainImage.src = asset.blockchain_logo || '';

        const std = asset.tokenStandard || 'Unknown';
        modalTokenStandard.textContent = std;
        modalTokenStandard.href = TOKEN_STANDARDS[std] || `https://google.com/search?q=${std}+token+standard`;

        // Setup Lens (Default: Issuer)
        lens.attestors = new Set();
        if (asset.issuer) {
            lens.attestors.add(asset.issuer);
        }
        lens.onchain = 'all';
        lens.chain = 'all';

        if (onchainSelect) onchainSelect.value = 'all';

        renderLensTags();
        renderCircles();

        assetModal.style.display = 'flex';
        assetModal.setAttribute('aria-hidden', 'false');
    }

    function renderLensTags() {
        if (!lensTags) return;
        lensTags.innerHTML = '';
        lens.attestors.forEach(attestor => {
            const tag = document.createElement('div');
            tag.className = 'lens-tag';
            tag.innerHTML = `${attestor} <span class="remove-tag" data-attestor="${attestor}">&times;</span>`;
            tag.querySelector('.remove-tag').addEventListener('click', (e) => {
                e.stopPropagation();
                lens.attestors.delete(attestor);
                renderLensTags();
                renderCircles();
            });
            lensTags.appendChild(tag);
        });
    }

    function populateAttestorDropdown() {
        if (!attestorDropdown) return;
        attestorDropdown.innerHTML = '';

        const uniqueAttestors = new Set();
        // Add existing attestors from data
        attestationsData.forEach(a => uniqueAttestors.add(a.attestor));

        // Explicitly add issuer if not present
        if (currentAsset.issuer) {
            uniqueAttestors.add(currentAsset.issuer);
        }

        uniqueAttestors.forEach(att => {
            // Only show if not already in lens
            if (!lens.attestors.has(att)) {
                const item = document.createElement('div');
                item.className = 'attestor-item';
                let label = att;
                if (currentAsset.issuer && att === currentAsset.issuer) {
                    label += ' (issuer)';
                }
                item.textContent = label;
                item.addEventListener('click', () => {
                    lens.attestors.add(att);
                    renderLensTags();
                    renderCircles();
                    attestorDropdown.style.display = 'none';
                });
                attestorDropdown.appendChild(item);
            }
        });
    }

    function renderCircles() {
        document.querySelectorAll('.attestation-circle').forEach(el => el.remove());

        const relevant = attestationsData.filter(a => {
            if (a.assetName !== currentAsset.name) return false;

            if (lens.attestors.size === 0) return false;
            if (!lens.attestors.has(a.attestor)) return false;

            if (lens.onchain === 'onchain' && !a.onchain) return false;
            if (lens.onchain === 'offchain' && a.onchain) return false;

            return true;
        });

        relevant.forEach((att, index) => {
            if (index >= 12) return;

            const circle = document.createElement('div');
            circle.className = 'attestation-circle';

            const now = new Date();
            const attDate = new Date(att.attestationDate);
            const expDate = att.expiryDate ? new Date(att.expiryDate) : new Date(attDate.getTime() + 365*24*60*60*1000);

            let isExpired = att.status === 'expired' || att.status === 'revoked' || now > expDate;
            let percentPassed = 0;

            if (!isExpired) {
                const totalDuration = expDate - attDate;
                const elapsed = now - attDate;
                if (totalDuration > 0) {
                    percentPassed = Math.max(0, Math.min(100, (elapsed / totalDuration) * 100));
                }
            } else {
                percentPassed = 100;
            }

            let color = '#48bb78'; // Green
            if (percentPassed > 75) color = '#f56565'; // Red
            else if (percentPassed > 50) color = '#ecc94b'; // Yellow

            if (att.status === 'revoked') color = '#f56565';

            const degrees = (percentPassed / 100) * 360;

            circle.style.background = `conic-gradient(${color} ${degrees}deg, #4a5568 ${degrees}deg)`;

            const inner = document.createElement('div');
            inner.style.position = 'absolute';
            inner.style.top = '4px';
            inner.style.left = '4px';
            inner.style.right = '4px';
            inner.style.bottom = '4px';
            inner.style.background = '#2d3748';
            inner.style.borderRadius = '50%';
            inner.style.zIndex = '0';
            circle.appendChild(inner);

            const text = document.createElement('span');
            text.textContent = att.schema;
            text.style.position = 'relative';
            text.style.zIndex = '1';
            text.style.fontSize = '8px';
            text.style.color = '#fff';
            text.style.textAlign = 'center';
            text.style.overflow = 'hidden';
            text.style.textOverflow = 'ellipsis';
            text.style.whiteSpace = 'nowrap';
            text.style.width = '100%';
            text.style.display = 'block';
            circle.title = att.schema; circle.appendChild(text);

            let top = 0, left = 0;
            const circleSize = 40;
            const cardW = 200;
            const cardH = 320;
            const offset = circleSize / 2;

            if (index < 4) { // Left Edge
                const step = cardH / 5;
                top = step * (index + 1) - offset;
                left = -offset;
            } else if (index < 6) { // Top Edge
                const step = cardW / 3;
                left = step * (index - 4 + 1) - offset;
                top = -offset;
            } else if (index < 10) { // Right Edge
                const step = cardH / 5;
                top = step * (index - 6 + 1) - offset;
                left = cardW - offset;
            } else { // Bottom Edge
                const step = cardW / 3;
                left = step * (index - 10 + 1) - offset;
                top = cardH - offset;
            }

            circle.style.position = 'absolute';
            circle.style.left = `${left}px`;
            circle.style.top = `${top}px`;

            circle.addEventListener('click', (e) => {
                e.stopPropagation();
                openAttestationDetails(att);
            });

            if (tokenCard) tokenCard.appendChild(circle);
        });
    }

    function openAttestationDetails(att) {
        document.getElementById('attTitle').textContent = att.schema;
        document.getElementById('attAttestor').textContent = att.attestor;
        document.getElementById('attDate').textContent = att.attestationDate;
        document.getElementById('attExpiry').textContent = att.expiryDate || 'N/A';
        document.getElementById('attStatus').textContent = att.status;
        document.getElementById('attType').textContent = att.onchain ? 'Onchain' : 'Offchain';

        const linkBtn = document.getElementById('attLink');
        if (att.link) {
            linkBtn.href = att.link;
            linkBtn.style.display = 'block';
        } else {
            linkBtn.style.display = 'none';
        }

        attestationModal.style.display = 'flex';
        attestationModal.setAttribute('aria-hidden', 'false');
    }
});
