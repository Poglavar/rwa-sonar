# RWA Sonar

RWA Sonar is a project modeled loosely on https://l2beat.com/

We will buy the domain rwasonar.com to host it on.

In the same way L2Beat has created a vocabulary to describe the state of L2 (layer 2) chains, we will create a vocabulary and site to describe the state of the RWA (real world asset) tokens in the crypto industry.

# Problem statement

The current problem is that all the assets are lumped together as "RWA assets" even though they diverge widely in features and capabilites. They are akin to icebergs which only have a small part visible above water. We will strive to determine which properties are truly relevant for understanding RWAs and then work to uncover them.

This is an opinionated exercise. We strive to have all world's assets representable on blockchain as the main ledger. The goal being easier tradeability and versatility and fewer disputes. Not every object in the real world is suitable for this. But those that are need to conform to a set of criteria. Ideally everybody should be able to do with their private property as they wish, meaning also being able to freely trade it to any willing party for a consideration the seller alone deems adequate. We also think the blockchain can be the main ledger only if it can be modified via a legal. Consider owning a home, if A sells it to B, but then court returns it to A, we need to have mechanisms to reflect that onchain. Ownership needs to update to A even if B refuses to go online.

So we have two conflicting goals: free transfers and also the government and the society recognizing the transfers as legitimate. These goals are in tension.

The idea is that there is a set of features/properties a RWA asset needs to "collect" in order to be considered to be of a certain level of maturity. There are multiple levels starting from level 0.

# Vocabulary

The vocabulary for describing the projects is such that a project can have both positive and negative characteristics. All characteristics are yes/no booleans. Yes means a positive, no means a negative. When we show them for an asset we will show them graphically as collections of dots/circles or small stacked squares. That way users can see graphically how many green flags vs red flags a project has. Here is the (work in progress) list of characteristics. They should all be "yes" for the tokenization to be considered to have reached the final stage of maturity.

    "titleDeed": "yes" // Is the ownership of the digital representation meant to record the ownership of the underlying
    underlyingSelfCustody: "yes" // can the asset represented by the token be custodied without third parties
    "bearerRedemption": "Yes"
    "blockchainIsMainledger": "Yes" // If there is an alternative ledger, such as government's land registry books, then this is a "No". Typically it will be "Yes" for RWAs whose ownership is not centrally tracked, for example, cars.
    "attestationAccrual": "",
    "issuerDisappearanceResistant": "Yes" // Is the token resistant to the disappearance of the issuing company/project/platform?
    "thirdPartyAttestations": "Yes",
    "selfCustody": "Yes": // but is this implied by uncoditional transfers?
    "meetingOfMinds": "Yes"
    "unconditionalTransfers": "Yes" // This
    "reactiveCompliance": "Yes" // Reactive as opposed to Proactive. Proactive compliance means unconditionalTransfers is "No". But unconditionalTransfers can be "Yes" without any compliance. So this means, if yes, that there is some compliance after transfers, that is, that there are forcedTransfers.
    "forcedTransfers": "Yes" // this is whether forced transfers are possible. If they are impossible the token could become lost (say, sent to 0x00 address). In such cases the RWA it represent is not also destroyed, so the question is raised what happens to the RWA?
        "issuerIndepedndent: "Yes" // If the issuer company/platform/protocol goes bankrupt, can the token still be used?
        "reflectLegalDecisions": "Yes" // Courts can decide to revert ownership. Can the token reflect this? If not, the token is meaningless as representation of ownership.
            "presetJurisdiction": "Yes", (via setting lens on transfer)
        "tokenTheftRecovery": "Yes",
        "tokenLossRecovery": "Yes",
        "lostWalletRecovery": "Yes" // If the user loses the wallet, say, by forgetting the seed phrase and losing the laptop, can they recover the token?
        "hackedWalletRecovery": "Yes" // When a user's seed phrase becomes public, can the token be recovered to the exclusive posession of the user?
        "heritability": "Yes" // Can the token be inherited?
    "AI-ready": "Yes" // We consider a token AI-ready if there is no KYC in the ownership loop. AI can't pass such humanity tests.

The Maturity Stage is defined thus (those that have not reached a higher level are considered level 0):

    Level 1: unconditionalTransfers, selfCustody
    Level 2: unconditionalTransfers, selfCustody, forcedTransfers
    Level 3: unconditionalTransfers, selfCustody, forcedTransfers, issuerBankruptcyAgnostic

Maturity Score: simple score arrived by assigning each yes a +1 and each no a -1 and adding them up.

# Future features

- Recipe built in
- enter URL and we perform the analysis
- Buy an attestation about uniqueness
- Derivatives platform. The asset is locked, but we trade the right to unlock the asset.

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
