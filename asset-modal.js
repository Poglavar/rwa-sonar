
document.addEventListener('DOMContentLoaded', () => {
    // State
    let attestationsData = [];
    let attestationTypesData = [];
    let recipesData = [];
    let currentAsset = null;
    let lens = {
        attestors: new Set(),
        onchain: 'all',
        chain: 'all',
        recipe: 'all'
    };

    // Constants
    const TOKEN_STANDARDS = {
        'ERC-20': 'https://ethereum.org/en/developers/docs/standards/tokens/erc-20/',
        'ERC-721': 'https://ethereum.org/en/developers/docs/standards/tokens/erc-721/',
        'SPL': 'https://spl.solana.com/token',
        'SToken-2022': 'https://spl.solana.com/token-2022'
    };

    // Card & circle dimensions
    const CARD_W = 280;
    const CARD_H = 420;
    const CIRCLE_SIZE = 24;
    const CIRCLE_OFFSET = CIRCLE_SIZE / 2;

    // Circle distribution: left 9, top 6, right 9, bottom 6 = 30 max
    const LEFT_COUNT = 9;
    const TOP_COUNT = 6;
    const RIGHT_COUNT = 9;
    const BOTTOM_COUNT = 6;
    const MAX_CIRCLES = LEFT_COUNT + TOP_COUNT + RIGHT_COUNT + BOTTOM_COUNT;

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
    const recipeSelect = document.getElementById('recipeSelect');

    // Load Data
    Promise.all([
        fetch('attestations-db.json').then(r => r.json()),
        fetch('attestation-types.json').then(r => r.json()),
        fetch('recipes-db.json').then(r => r.json())
    ]).then(([attestations, types, recipes]) => {
        attestationsData = attestations;
        attestationTypesData = types;
        recipesData = recipes;
        populateRecipeDropdown();
    }).catch(err => console.error("Failed to load data:", err));

    // Populate recipe dropdown
    function populateRecipeDropdown() {
        if (!recipeSelect) return;
        // Keep the "All Attestations" default
        recipesData.forEach(recipe => {
            const opt = document.createElement('option');
            opt.value = recipe.name;
            opt.textContent = `${recipe.name} (${recipe.author})`;
            recipeSelect.appendChild(opt);
        });
    }

    if (recipeSelect) {
        recipeSelect.addEventListener('change', () => {
            lens.recipe = recipeSelect.value;
            renderCircles();
        });
    }

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

        // Setup Lens (Default: all attestors for this asset)
        lens.attestors = new Set();
        lens.onchain = 'all';
        lens.chain = 'all';
        lens.recipe = recipeSelect ? recipeSelect.value : 'all';

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
        attestationsData.forEach(a => uniqueAttestors.add(a.attestor));

        if (currentAsset.issuer) {
            uniqueAttestors.add(currentAsset.issuer);
        }

        uniqueAttestors.forEach(att => {
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

    // Position a circle by index around the card edges
    function getCirclePosition(index, total) {
        // Distribute circles clockwise: left (top-to-bottom), bottom (left-to-right), right (bottom-to-top), top (right-to-left)
        let top = 0, left = 0;

        if (index < LEFT_COUNT) {
            // Left edge, top to bottom
            const step = CARD_H / (LEFT_COUNT + 1);
            top = step * (index + 1) - CIRCLE_OFFSET;
            left = -CIRCLE_OFFSET;
        } else if (index < LEFT_COUNT + BOTTOM_COUNT) {
            // Bottom edge, left to right
            const i = index - LEFT_COUNT;
            const step = CARD_W / (BOTTOM_COUNT + 1);
            left = step * (i + 1) - CIRCLE_OFFSET;
            top = CARD_H - CIRCLE_OFFSET;
        } else if (index < LEFT_COUNT + BOTTOM_COUNT + RIGHT_COUNT) {
            // Right edge, bottom to top
            const i = index - LEFT_COUNT - BOTTOM_COUNT;
            const step = CARD_H / (RIGHT_COUNT + 1);
            top = CARD_H - step * (i + 1) - CIRCLE_OFFSET;
            left = CARD_W - CIRCLE_OFFSET;
        } else {
            // Top edge, right to left
            const i = index - LEFT_COUNT - BOTTOM_COUNT - RIGHT_COUNT;
            const step = CARD_W / (TOP_COUNT + 1);
            left = CARD_W - step * (i + 1) - CIRCLE_OFFSET;
            top = -CIRCLE_OFFSET;
        }

        return { top, left };
    }

    function renderCircles() {
        document.querySelectorAll('.attestation-circle').forEach(el => el.remove());
        if (!currentAsset) return;

        const selectedRecipe = recipesData.find(r => r.name === lens.recipe);

        if (selectedRecipe) {
            renderRecipeCircles(selectedRecipe);
        } else {
            renderAllAttestationsCircles();
        }
    }

    // Recipe mode: show all recipe attestation types, filled if exists, empty if missing
    function renderRecipeCircles(recipe) {
        const assetAttestations = attestationsData.filter(a => a.assetName === currentAsset.name);

        recipe.attestationTypes.forEach((recipeItem, index) => {
            if (index >= MAX_CIRCLES) return;

            // Find matching attestation for this asset
            const match = assetAttestations.find(a => a.attestationTypeId === recipeItem.attestationTypeId);

            // Find the attestation type definition for the label
            const typeDef = attestationTypesData.find(t => t.id === recipeItem.attestationTypeId);
            const label = typeDef ? typeDef.name : recipeItem.attestationTypeId;

            // Apply onchain filter — skip if doesn't match filter
            if (match) {
                if (lens.onchain === 'onchain' && !match.onchain) return;
                if (lens.onchain === 'offchain' && match.onchain) return;
            }

            // Apply attestor filter — if attestors selected, only show matching filled ones (but always show empty)
            if (match && lens.attestors.size > 0 && !lens.attestors.has(match.attestor)) {
                // Attestation exists but attestor doesn't match lens — show as empty
                createCircle(index, label, null, recipeItem);
                return;
            }

            createCircle(index, label, match, recipeItem);
        });
    }

    // All attestations mode (no recipe): show only existing attestations for this asset
    function renderAllAttestationsCircles() {
        const relevant = attestationsData.filter(a => {
            if (a.assetName !== currentAsset.name) return false;

            if (lens.attestors.size > 0 && !lens.attestors.has(a.attestor)) return false;

            if (lens.onchain === 'onchain' && !a.onchain) return false;
            if (lens.onchain === 'offchain' && a.onchain) return false;

            return true;
        });

        relevant.forEach((att, index) => {
            if (index >= MAX_CIRCLES) return;

            const label = att.schema || att.attestationTypeId || 'Attestation';
            createCircle(index, label, att, null);
        });
    }

    function createCircle(index, label, attestation, recipeItem) {
        const circle = document.createElement('div');
        circle.className = 'attestation-circle';

        const isEmpty = !attestation;

        if (isEmpty) {
            circle.classList.add('empty-attestation');
        } else {
            // Build SVG progress ring
            const now = new Date();
            const attDate = new Date(attestation.attestationDate);
            const expDate = attestation.expiryDate ? new Date(attestation.expiryDate) : null;

            let percentPassed = 0;
            let isExpired = attestation.status === 'expired' || attestation.status === 'revoked';

            if (expDate) {
                isExpired = isExpired || now > expDate;
                if (!isExpired) {
                    const totalDuration = expDate - attDate;
                    const elapsed = now - attDate;
                    if (totalDuration > 0) {
                        percentPassed = Math.max(0, Math.min(100, (elapsed / totalDuration) * 100));
                    }
                } else {
                    percentPassed = 100;
                }
            }
            // No expiry = permanent attestation, show as full green
            if (!expDate && !isExpired) {
                percentPassed = 0;
            }

            let color = '#48bb78'; // Green
            if (isExpired) color = '#f56565';
            else if (percentPassed > 75) color = '#f56565';
            else if (percentPassed > 50) color = '#ecc94b';

            if (attestation.status === 'revoked') color = '#f56565';

            const size = CIRCLE_SIZE;
            const strokeWidth = 3;
            const radius = (size - strokeWidth) / 2;
            const circumference = 2 * Math.PI * radius;
            const filled = (percentPassed / 100) * circumference;
            const gap = circumference - filled;

            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('width', size);
            svg.setAttribute('height', size);
            svg.style.position = 'absolute';
            svg.style.top = '0';
            svg.style.left = '0';

            // Background track
            const bgCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            bgCircle.setAttribute('cx', size / 2);
            bgCircle.setAttribute('cy', size / 2);
            bgCircle.setAttribute('r', radius);
            bgCircle.setAttribute('fill', 'none');
            bgCircle.setAttribute('stroke', '#4a5568');
            bgCircle.setAttribute('stroke-width', strokeWidth);
            svg.appendChild(bgCircle);

            // Filled arc
            if (percentPassed > 0) {
                const fgCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                fgCircle.setAttribute('cx', size / 2);
                fgCircle.setAttribute('cy', size / 2);
                fgCircle.setAttribute('r', radius);
                fgCircle.setAttribute('fill', 'none');
                fgCircle.setAttribute('stroke', color);
                fgCircle.setAttribute('stroke-width', strokeWidth);
                fgCircle.setAttribute('stroke-dasharray', `${filled} ${gap}`);
                fgCircle.setAttribute('stroke-linecap', 'round');
                fgCircle.setAttribute('transform', `rotate(-90 ${size / 2} ${size / 2})`);
                svg.appendChild(fgCircle);
            }

            // For permanent attestations (no expiry), show full green ring
            if (!expDate && !isExpired) {
                const fullCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                fullCircle.setAttribute('cx', size / 2);
                fullCircle.setAttribute('cy', size / 2);
                fullCircle.setAttribute('r', radius);
                fullCircle.setAttribute('fill', 'none');
                fullCircle.setAttribute('stroke', color);
                fullCircle.setAttribute('stroke-width', strokeWidth);
                svg.appendChild(fullCircle);
            }

            circle.appendChild(svg);
        }

        // Tooltip label
        const text = document.createElement('span');
        text.textContent = label;
        circle.title = label;
        circle.appendChild(text);

        // Position
        const pos = getCirclePosition(index, MAX_CIRCLES);
        circle.style.position = 'absolute';
        circle.style.left = `${pos.left}px`;
        circle.style.top = `${pos.top}px`;

        // Click handler
        circle.addEventListener('click', (e) => {
            e.stopPropagation();
            if (attestation) {
                openAttestationDetails(attestation);
            } else if (recipeItem) {
                openMissingAttestationDetails(recipeItem);
            }
        });

        if (tokenCard) tokenCard.appendChild(circle);
    }

    function openAttestationDetails(att) {
        document.getElementById('attTitle').textContent = att.schema || att.attestationTypeId;
        document.getElementById('attAttestor').textContent = att.attestor;
        document.getElementById('attDate').textContent = att.attestationDate;
        document.getElementById('attExpiry').textContent = att.expiryDate || 'Permanent';
        document.getElementById('attStatus').textContent = att.status;
        document.getElementById('attType').textContent = att.onchain ? 'Onchain' : 'Offchain';

        const noteRow = document.getElementById('attNoteRow');
        const noteSpan = document.getElementById('attNote');
        if (noteRow && noteSpan) {
            if (att.note) {
                noteSpan.textContent = att.note;
                noteRow.style.display = 'flex';
            } else {
                noteRow.style.display = 'none';
            }
        }

        const linkBtn = document.getElementById('attLink');
        if (att.link && att.link !== '#') {
            linkBtn.href = att.link;
            linkBtn.style.display = 'block';
        } else {
            linkBtn.style.display = 'none';
        }

        attestationModal.style.display = 'flex';
        attestationModal.setAttribute('aria-hidden', 'false');
    }

    function openMissingAttestationDetails(recipeItem) {
        const typeDef = attestationTypesData.find(t => t.id === recipeItem.attestationTypeId);

        document.getElementById('attTitle').textContent = typeDef ? typeDef.name : recipeItem.attestationTypeId;
        document.getElementById('attAttestor').textContent = typeDef ? typeDef.attestorType : '—';
        document.getElementById('attDate').textContent = '—';
        document.getElementById('attExpiry').textContent = '—';
        document.getElementById('attStatus').textContent = 'Missing';
        document.getElementById('attType').textContent = recipeItem.required ? 'Required' : 'Optional';

        const noteRow = document.getElementById('attNoteRow');
        const noteSpan = document.getElementById('attNote');
        if (noteRow && noteSpan) {
            const note = recipeItem.note || (typeDef ? typeDef.description : '');
            if (note) {
                noteSpan.textContent = note;
                noteRow.style.display = 'flex';
            } else {
                noteRow.style.display = 'none';
            }
        }

        const linkBtn = document.getElementById('attLink');
        linkBtn.style.display = 'none';

        attestationModal.style.display = 'flex';
        attestationModal.setAttribute('aria-hidden', 'false');
    }
});
