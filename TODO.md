# RWA Sonar

RWA Sonar is a project modeled loosely on https://l2beat.com/
It is hosted on https://rwasonar.com/

In the same way L2Beat has created a vocabulary to describe the state of L2 (layer 2) chains, we will create a vocabulary and site to describe the state of the RWA (real world asset) tokens in the crypto industry.

# Problem statement

The current problem is that all the assets are lumped together as "RWA assets" even though they diverge widely in features and capabilites. They are akin to icebergs which only have a small part visible above water. We will strive to determine which properties are truly relevant for understanding RWAs and then work to uncover them.

This is an opinionated exercise. We strive to have all world's assets representable on blockchain as the main ledger. The goal being easier tradeability and versatility and fewer disputes. Not every object in the real world is suitable for this. But those that are need to conform to a set of criteria. Ideally everybody should be able to do with their private property as they wish, meaning also being able to freely trade it to any willing party for a consideration the seller alone deems adequate. We also think the blockchain can be the main ledger only if it can be modified via a legal. Consider owning a home, if A sells it to B, but then court returns it to A, we need to have mechanisms to reflect that onchain. Ownership needs to update to A even if B refuses to go online.

So we have two conflicting goals: free transfers and also the government and the society recognizing the transfers as legitimate. These goals are in tension.

The idea is that there is a set of features/properties a RWA asset needs to "collect" in order to be considered to be of a certain level of maturity. There are multiple levels starting from level 0.

# Vocabulary

See [vocabulary.md](./vocabulary.md) for the full vocabulary spec.

# Architecture

The projects consists of a backend and frontend.

## Frontend

It is a simple web site (html + css + js). Keep most of the javascript in .js files and most of the css in .css files (as much as possible). The entry point is index.html

It has the logo, the blurb explaining the reason for the site and a list of rwa assets as rows. The columns are the properties we analyze.

The first column is a thumbnail of the RWA asset image. The two bars (positive and negative) are in the next column. The third column is the "Maturity score" which is a simple positive - negative sum (can be a negative number). The next column is "Maturity Stage" (see how it is calculated in the Vocabulary section). After that is one column per Property and the value in the column is the yes/no value of the property.

## Backend

Later on we will build a proper database and endpoints. For now it is not needed. The database will be a .json file of crypto assets, populated manually. File name will be rwa-assets-db.json. It will be usable by the index.html via javascipt file rwa-assets-db.js

Each asset in the json db will have general data and the properties from the Vocabulary described above. Example of the general data:

    "name": "XAUT Tokenized Gold",
    "ticker": "XAUT",
    "type": "Tokenized Commodity",
    "description": "XAUT is a digital token backed 1:1 by physical gold",
    "website": "https://www.tether.to/en/xaut/",
    "image": "https://www.tether.to/wp-content/uploads/2021/03/xaut.png",
    "blockchain": "Ethereum",
    "contractAddress": "0x68749665ff8d2d112fa859b1dbd9e746f086c",
    "tokenStandard": "ERC-20",
    "recipe": "https://attestify.network/recipes/0x4df8273416cce58ec71113c1435818c9ed429762693e80ac665b58cb17a6d190"

# TODO

- Recipe built in
- enter URL and we perform the analysis
- Buy an attestation about uniqueness (the problem to solve: what if person tried to tokenize same thing on several platforms)
- Derivatives platform. The asset is locked, but we trade the right to unlock the asset. What if the right is lost?
- For each asset, add links to third party sites with more information, for example for XAUT:
  - main/issuer page (https://gold.tether.to/)
  - coingecko.com (https://www.coingecko.com/en/coins/tether-gold)
  - defillama.com (https://defillama.com/rwa/asset/xaut)
  - rwa.xyz (https://app.rwa.xyz/assets/XAUT)
    Have these as four small icons, or pill-style buttons with very small font, and put them in one column called "Links"

- OK let's build individual asset cards (large, but not full screen, almost full screen lenghtwise and less widthwise) for each asset. They should open when an asset is clicked in the items list. The card should consist of a drawing which visually represents the token and the attestations attached to it. The token should be a card (like a playing card, "token card" from now), a rectangle with rounded edges. In the rectangle should be the image/icon of the asset and also an icon for the chain the asset is on, as well as the token standard the asset is using. The token standard should be a link to the relevant site explaining the token standard. The edge of the token card should have attached (overlapping) small circles. The circles would be small so that 4 can fit on a vertical edge of the playing card and 2 on a horizontal edge. The circles can either be empty or filled. When filled each circle represents one attestation that pertains to the token. One word is shown in the circle and it is "attestation schema" from the attestation properties, truncated to fit. An attestation can be either onchain or offchain. A border around the attestation circle shows the attestation state. If the border is full circle and red, the attestation is expired or revoked. The border can be less than 360 degrees filled. The percentage filled should depend on what percentage of time between attestation date and its expiry date has passed (if attestation has no expiry date, one year is assumed). If the time difference is 30 days and 15 have passed, the border should be 180 degrees filled. The colouring should be such that 180-360 degrees is green, 90-190 degrees is yellow, 0-90 degrees is red. The asset card should also have a lens section. This is an aread with a border and "Lens" inscribed. Initially on Asset Card load the Lens is populated with the Attestors whose attestations we want to see attached to the Token Card. Initially only the Issuer Entity for the Asset in question comes prefilled. This name is shown as a label with an X on its right, meaning it can be removed. There is also a plus (+) icon or symbol below it allowing to add more entities. When clicked it shows a list of entities the used can add. Each added entity shows up as a label with an x and can be removed. The list of entities is produced initially by looking at the database of the attestations for all the assets. Adding/removing an Attestor label to the lens controls whether its attestations for the token (if any exist) are added or removed. Two dropdowns exist outside the lens section. A dropdown with "onchain/offchain" selection for attestations and a dropdown to select a chain (enabled if "onchain" is selected on the previous dropdown. The three dropdowns should be one below the other, to the right of the token card.
