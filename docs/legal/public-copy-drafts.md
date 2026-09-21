# Draft public copy

> **Superseded as the source of the shipped text.** The implemented copy lives in
> `packages/contracts/src/legal-documents.ts`, where it is versioned and hashed so an acceptance
> record resolves to the exact text it was given for. This file remains the drafting notes and
> the review brief it was written as; edit the registry, run `pnpm legal:hashes`, and the
> contracts test keeps the two in step.

DRAFT — not approved for publication. English matches the existing product UI. All bracketed
owner fields below must be resolved; translations/language requirements need territorial review.
Read `owner-inputs-and-review.md`. Public text must match actual implementation and contracts.

## Short reusable disclosures

**Footer:** Research and simulation tools. Not investment advice. Data may contain errors or delays.

**Dashboard / Monitor:** Signals reflect automated strategy conditions and lifecycle rules, not
instructions to trade. Pending setups have not yet become active signals. Verify current market
information before making an investment decision. Read the Risk Disclosure.

**Backtest results:** Hypothetical historical results. Results depend on the selected data,
assumptions and simulation methodology and do not represent actual trading performance.
Historical or simulated performance does not guarantee future returns.

**Valuations:** Model-based estimates, not guaranteed market prices or investment outcomes.

**Terms checkbox:** I agree to the Terms of Service.

**Privacy information next to signup:** Read our Privacy Policy to learn how we use your personal data.

**Existing-account notice:** Please review and accept our Terms of Service to continue using account
features. You can still access support, privacy requests and subscription cancellation without accepting.

**Optional-storage banner (only if applicable):** We use necessary storage to operate FactorSage.
With your permission, we also store preferences such as recently viewed stocks on this device.
You can reject optional storage and change your choice at any time in Cookie settings.

Actions: Accept all / Reject optional / Customize. Adapt categories to the verified inventory;
do not mention advertising or analytics if they do not exist.

## Risk Disclosure — draft page

FactorSage provides tools for financial research, strategy analysis and historical simulation. Its
outputs are not intended as investment advice or recommendations to buy, sell or hold any security.
FactorSage does not assess your financial circumstances, investment objectives or risk tolerance.

Strategy signals and BUY, SELL or FINAL EXIT labels describe the evaluation of specified strategy
rules. They are not instructions to trade. Active signals may persist under a strategy's lifecycle
rules; they do not necessarily mean a trigger has just occurred. Pending setups are not active signals.
Built-in strategies are illustrative examples and have not been assessed for suitability for you.

Market data is obtained from external sources and processed by FactorSage. Data and calculated
outputs may contain errors, omissions or delays. Except as required by applicable law, FactorSage
does not warrant their accuracy, completeness or timeliness. Independently verify material
information before making investment decisions. Displayed timestamps describe the observation
or update identified on the relevant screen and do not guarantee an executable market price.

Valuations are model-based estimates. Different assumptions and models can produce different
results. An estimated intrinsic value is not a promise that the market price will reach that value.

Backtest results are hypothetical and do not represent actual trades. They depend on the selected
universe, historical data, parameters and execution methodology. Real trading can differ because of
liquidity, execution prices, transaction costs, taxes, market conditions and other factors. Only the
costs and assumptions expressly described in the applicable methodology are included. Selection
and survivorship biases can affect results. Historical or simulated performance does not guarantee
future returns. Investing involves the risk of loss.

You remain responsible for your investment decisions. To the extent permitted by applicable law,
FactorSage excludes liability for investment losses arising from reliance on its data or outputs.
Nothing in this notice excludes or limits liability that cannot lawfully be excluded or limited,
or affects mandatory consumer rights.

## Terms of Service — draft structure and clauses

### Operator and scope

FactorSage is operated by [LEGAL_ENTITY_NAME], registered at [REGISTERED_ADDRESS], with
[REGISTRATION_IDENTIFIER] and [APPLICABLE_TAX_IDENTIFIER]. Contact: [SUPPORT_CONTACT].
These terms govern your use of FactorSage's research, valuation, strategy, backtesting and
monitoring features. The Risk Disclosure forms part of these terms.

### Accounts and acceptable use

Keep your sign-in credentials secure and provide accurate account information. You must have the
legal capacity to enter this contract. Do not attempt unauthorized access, interfere with service
operation, bypass technical or subscription limits, or use the service unlawfully. Automated access,
redistribution and use of market data are subject to the permissions expressly provided by the
service and applicable data licenses. [CONFIRM_AGE_AND_DATA_LICENSE_RULES].

### Service and subscriptions

Available features and usage limits are described in the current plan information. Your selected
plan, billing interval, price, applicable taxes and renewal terms are shown before purchase.
Subscriptions renew automatically unless canceled in accordance with the terms shown at purchase.
Canceling renewal normally leaves access available until the end of the paid period, as displayed
in Billing. Statutory withdrawal and remedies for nonconforming services are separate rights; see
Cancellation & refunds. [CONFIRM_TAX_AND_CONSUMER_WORDING].

### Data, simulations and responsibility

Use the substantive Risk Disclosure above. Do not replace it with a blanket disclaimer that all
service quality obligations disappear. The service must still meet applicable mandatory standards.

### Liability

To the extent permitted by applicable law, we exclude liability for investment losses resulting
from reliance on market data, model estimates, strategy outputs or simulated results. Nothing in
these terms excludes or limits liability that cannot lawfully be excluded or limited, including
liability for fraud, intentional misconduct or gross negligence where applicable law prohibits
such limitation. Your mandatory consumer rights remain unaffected.

[LEGAL_REVIEW_REQUIRED: scope of recoverable loss, enforceability, Romanian law and any proposed
monetary cap. Do not insert an arbitrary subscription-fee cap or indemnity against consumer claims.]

### Remaining sections to finalize

- Service availability and maintenance: factual commitments, outage handling and mandatory remedies.
- Intellectual property: operator rights, third-party rights, and the limited rights needed to process
  user-created lists/strategies; do not assert ownership of user content without a basis.
- Suspension/termination: proportionate grounds, notice where appropriate, challenge/contact route,
  treatment of paid access and statutory refunds. No unrestricted right to take money and terminate.
- Changes: notice, prospective effective date, material-change handling and consumer protections.
- Governing law/disputes: [LEGAL_REVIEW_REQUIRED]; preserve mandatory consumer jurisdiction/rights.
- Complaints/ADR: verified applicable Romanian mechanism and contact information.

## Privacy Policy — required content template

Publish complete sentences based on the approved inventory; the table is an authoring checklist,
not a substitute for a completed notice.

| Section | Required verified information |
| --- | --- |
| Controller | Legal name/address and privacy contact; DPO only if appointed/required. |
| Account | Email, password hash where used, Google identity link, verification/recovery data; purposes and legal bases. |
| Product | User lists, strategies, runs, monitors, preferences and recent securities; reasons for processing. |
| Security | Session metadata, rate-limit data and operational logs; actual scope, grounds and retention. |
| Billing | Customer/subscription identifiers and transaction-related information; Stripe's applicable role; statutory records. Do not claim full card data is stored locally. |
| Acceptance | Terms versions/timestamps, privacy notice delivery where recorded, optional consent evidence. |
| Recipients | Actual hosting, email, billing, identity and observability providers and their roles. |
| Transfers | Actual processing countries and applicable safeguards, not an assumed EU-only claim. |
| Retention | Duration or objective criteria per category, account closure, backups and legal holds. |
| Rights | Access, correction, erasure, restriction, objection, portability and consent withdrawal as applicable; request channel and identity verification. |
| Complaints | Relevant supervisory authority and correct contact/link, including ANSPDCP where applicable. |
| Other disclosures | Required versus optional data and consequences; automated decision-making/profiling assessment; sources of indirectly obtained personal data where applicable. |

Do not write "we never share your data" when providers receive it. Privacy consent is not required
for every contractual/legal-obligation processing activity. Marketing opt-in, if later introduced,
requires separate scope and implementation; it is not authorized by accepting these terms.

## Cookie Policy — initial inventory template

| Technology | Purpose | Duration | Classification/status |
| --- | --- | --- | --- |
| Configured auth cookie | Keep requested session authenticated | Actual configured session TTL | Necessary candidate; confirm deployment name/domain and exact behavior. |
| Auth-name + `_oauth_tx` cookie | Secure Google OAuth round trip | 10 minutes; cleared after callback | Necessary when Google flow requested; `/auth` path. |
| `factorsage.recent-securities.v1` localStorage | Remember guest recently viewed securities | Currently no timed expiry in helper | Optional preference by conservative implementation default; document new approved expiry if added. |
| Consent choice storage, when implemented | Remember user's privacy selection | [APPROVED_DURATION] | Needed to honor choice; include actual format/name once implemented. |
| Other deployed technologies | [COMPLETE_RUNTIME_INVENTORY] | [ACTUAL_DURATION] | Classify before publication. |

Explain how to change choices and clear storage. Distinguish FactorSage pages from external Google
and Stripe pages. Do not invent third-party cookie names or imply every Stripe cookie is necessary.

## Cancellation & refunds — draft page structure

**Cancel renewal.** You can manage your subscription in Billing. Canceling renewal prevents the
next renewal charge and normally preserves access until the end of the current paid period. The
effective date is displayed before confirmation.

**Statutory withdrawal.** Depending on your location and contract, you may have a statutory right
to withdraw. [INSERT_REVIEWED_PERIOD_START_RULES_PROCEDURE_MODEL_FORM_AND_SERVICE_START_EFFECTS].
Use [IMPLEMENTED_WITHDRAWAL_FUNCTION] or contact [VERIFIED_CONTACT]. We will confirm receipt on a
durable medium. Submission acknowledgment is not a statement that a refund has already been made.

**Problems with the service.** Contact [VERIFIED_CONTACT] if the service does not meet the applicable
contractual or legal requirements. Mandatory rights and remedies are not excluded by our renewal
cancellation policy or by expiry of a withdrawal period.

Do not publish until legal rules, actual handling, required model form, contact, and confirmation
delivery are complete. No blanket "all sales final" or automatic waiver at account creation.

## Contact / legal information template

Product: FactorSage. Operator: [LEGAL_ENTITY_NAME]. Registered address: [REGISTERED_ADDRESS].
Registration: [REGISTRATION_IDENTIFIER]. Tax identification: [APPLICABLE_TAX_IDENTIFIER].
Support/complaints: [SUPPORT_CONTACT]. Privacy requests: [PRIVACY_CONTACT].
[OTHER_REQUIRED_CONTACT_DETAILS_AND_APPLICABLE_ADR_INFORMATION].

Keep personal contact details and supplier contracts out of this public repository unless the owner
has explicitly approved publication. The repository is public; placeholders are deliberate.
