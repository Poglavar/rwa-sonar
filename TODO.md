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
- Buy an attestation about uniqueness
- Derivatives platform. The asset is locked, but we trade the right to unlock the asset.
- for each asset, add links to third party sites with more information, for example for XAUT:
  - main/issuer page (https://gold.tether.to/)
  - coingecko.com (https://www.coingecko.com/en/coins/tether-gold)
  - defillama.com (https://defillama.com/rwa/asset/xaut)
  - rwa.xyz (https://app.rwa.xyz/assets/XAUT)
