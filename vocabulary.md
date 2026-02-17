# Vocabulary

Our intention here is to move away from "tokenized" as a single qualifier to a more fine-grained understanding of the degree of tokenization. The most tokenized assets are those where four main pillars are present:

1. the blockchain is the main ledger for recording ownership (**blockchainIsMainLedger**),
2. the tokens can be freely transferred to any chain address (**unconditionalTransfers**),
3. there is no vendor/issuer lock-in (**bearerRedemption**), but
4. the decisions of the legal system can affect the ledger state (**forcedTransfers**)

## Maturity Stage

The Maturity Stage is a tiered classification. An asset that has not reached a higher level is considered Level 0.

- **Level 1**: **blockchainIsMainLedger**
- **Level 2 - Tokenized **: **Level 1** + **unconditionalTransfers**
- **Level 3 - Issuer independent**: **Level 2** + **bearerRedemption**
- **Level 4 - Legally Integrated**: **Level 3** + **forcedTransfers**

(Note that there are also trust assumptions about blockchains. Some blockchains are more trustworthy. However here we ignore that complexity and assume all chains are rock solid.)

## Definitions

The vocabulary for describing RWA tokenization projects is such that a project can have both positive and negative characteristics. All characteristics are yes/no booleans. "Yes" means a positive, "no" means a negative. The more characteristics are "yes" the more mature the tokenization is considered to be.

- **titleDeed**: Is the ownership of the token meant to record the full ownership rights and obligations for the underlying asset, commonly understood. This is in contrast to the token representing a derived or partial right.
- **assetSelfCustody**: Can the asset represented by the token be custodied by the owner without third parties? A token could represent a tangible thing, which can be in posession of the owner, or it could be something intangible, which cannot be physically held.
- **blockchainIsMainLedger**: Is the blockchain the primary ledger of ownership? If there is an alternative authoritative ledger, such as a government land registry, then this is "no". Typically "yes" for RWAs whose ownership is not centrally tracked, for example cars. Typically "no" for RWAs whose ownership is centrally tracked, for example real estate.
- **unconditionalTransfers**: Can the token be transferred freely, without requiring approval from a gatekeeper (issuer, platform, or regulator)?. This implies **reactiveCompliance**, which is the approach where any compliance requirements are enforced reactively (after the transfer) rather than proactively (blocking transfers).
- **tokenSelfCustody**: Can the token holder hold the token in their own wallet without relying on a third-party custodian?
- **bearerRedemption**: Can the token holder redeem the underlying asset from a third party custodian simply by presenting (bearing) the token?
- **issuerIndependent**: If the issuer company/platform/protocol goes bankrupt or disappears offline, will the token continue to function and retain its meaning?
- **forcedTransfers**: Can an tokens be moved without the holder's consent? This is necessary for legal compliance and also loss. Tokens can be sent to unreachable addresses (e.g. 0x00) which will not destroy the underlying RWA (say, a house). There must be a mechanism to correct this. This also enables **tokenTheftRecovery** (if a token is stolen (e.g. via a phishing attack), can it be recovered to the rightful owner?), **tokenLossRecovery** (if a token is sent to an unreachable address by mistake, can it be recovered?) and **heritability** (can the token be inherited by legal heirs upon the death of the owner).
- **reflectLegalDecisions**: Can court decisions (e.g. reverting ownership, seizing assets) be enforced on-chain? If not, the token is insufficient as a representation of ownership.
- **presetJurisdiction**: Is there a defined legal jurisdiction governing the token, so that the applicable legal framework is unambiguous?
- **meetingOfMinds**: Is the transfer considered valid on the basis of the agreement between buyer and seller alone, without requiring third-party sign-off?
- **thirdPartyAttestations**: Can independent third-party (non-issuer) attestations be attached to the token, verifying the link between the token and the underlying asset?
- **aiReady**: We consider a token AI-ready if there is no KYC in the transfer loop. AI agents cannot pass humanity tests, so KYC requirements exclude them from participation. This will be true if **unconditionalTransfers** is "yes" and **tokenSelfCustody** is "yes".

## Maturity Score

A simple score arrived at by assigning each "yes" a +1 and each "no" a -1 and summing. Can be negative.
