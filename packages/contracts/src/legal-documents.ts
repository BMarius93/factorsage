import { LEGAL_DOCUMENT_CONTENT_HASHES } from "./legal-document-hashes.js";
import {
  canonicalLegalDocumentText,
  type LegalDocument,
  type LegalDocumentKind,
} from "./legal.js";

/**
 * The immutable, versioned text of every public legal document.
 *
 * **Status: DRAFT. None of this wording is approved for publication.** It is written to be
 * substantively accurate about what FactorSage actually does — what a signal is, what a backtest
 * includes, what is stored in a browser, what cancelling a renewal does — so that a reviewer is
 * correcting law and wording rather than correcting the product description. It is not legal
 * advice and it is not a compliance certification.
 *
 * ## Why the text lives here
 *
 * An acceptance event has to resolve to the exact text that was accepted. Keeping the text in one
 * versioned registry, hashing it, and storing that hash on the event is what makes that true.
 * `legal-documents.test.ts` recomputes every hash, so editing a sentence without bumping the
 * version and the digest fails the build — a stored acceptance can therefore never silently come
 * to mean something its signer never read.
 *
 * ## What is deliberately absent
 *
 * Owner facts. The operator's legal name, address, identifiers and contacts are `{{PLACEHOLDER}}`
 * markers resolved from deployment configuration, because this repository is public and inventing
 * them — or committing the real ones — are both wrong. An unresolved marker renders as a visible
 * draft notice and blocks a release build.
 *
 * Also absent: any claim that a disclaimer eliminates liability, any blanket "no refunds", any
 * automatic waiver of consumer rights, any retention period, any statement about which providers
 * process data, and any conclusion about how the service is classified under consumer or financial
 * regulation. Those are `O4`, `O5`, `O7`, `O9`, `O10`, `O11` and `O12`, and each is marked in
 * place.
 */

const DRAFT_DATE = "2026-09-21";
const DRAFT_VERSION = "0.1.0-draft";

const RISK_DISCLOSURE: LegalDocument = {
  kind: "RISK_DISCLOSURE",
  route: "/risk-disclosure",
  title: "Risk disclosure",
  summary:
    "What FactorSage's outputs are, what their limits are, and who is responsible for an investment decision.",
  version: DRAFT_VERSION,
  effectiveDate: DRAFT_DATE,
  status: "DRAFT",
  contentHash: "",
  sections: [
    {
      id: "what-this-is",
      heading: "What FactorSage is",
      paragraphs: [
        "FactorSage provides tools for financial research, strategy analysis and historical simulation. Its outputs are not investment advice and are not recommendations to buy, sell or hold any security.",
        "FactorSage does not assess your financial circumstances, investment objectives, knowledge, experience or risk tolerance, and nothing it displays is personalised to them.",
      ],
    },
    {
      id: "signals",
      heading: "Strategy signals and BUY, SELL and FINAL EXIT labels",
      paragraphs: [
        "A signal describes the evaluation of the strategy rules you or an administrator configured, against the data FactorSage holds. BUY, SELL and FINAL EXIT are labels for levels of a strategy definition. They are descriptions of a rule evaluation, not instructions to trade.",
        "An active signal is not necessarily a trigger that has just occurred. Where a level has a trigger, the signal becomes active when the trigger fires and stays active — latched — while the level's conditions continue to hold. A pending setup is a level whose conditions hold but whose trigger has not fired; it is not a signal.",
        "Built-in strategies are illustrative examples of what the product can express. They have not been assessed for suitability for you or for anyone else.",
      ],
      pending: {
        ownerInput: "O10",
        note: "Financial-regulatory counsel must classify the built-in strategies and the public BUY/SELL outputs. Describing an output as educational or as a rule match is not, by itself, an exemption.",
      },
    },
    {
      id: "market-data",
      heading: "Market data",
      paragraphs: [
        "Market data is obtained from an external provider and is processed by FactorSage. Data and calculated outputs may contain errors, omissions, gaps or delays, and coverage differs between securities and between datasets.",
        "Except to the extent applicable law does not allow it to be excluded, FactorSage does not warrant the accuracy, completeness or timeliness of that data. Verify material information independently before making an investment decision.",
        "Times shown on a screen describe the observation or update that screen identifies — a quote time, a monitor scan time, or the date of an end-of-day series. They are distinct from one another, they are not all real time, and none of them is a guarantee of a price at which anything could be executed.",
      ],
    },
    {
      id: "valuations",
      heading: "Valuations and model estimates",
      paragraphs: [
        "Intrinsic-value figures are model outputs. They depend on the model, on its assumptions and on the fundamental data available at the point in time being calculated. Different models and different assumptions produce different results.",
        "An estimated intrinsic value is not a statement that a security is worth that amount and is not a prediction that its market price will move toward that amount.",
      ],
    },
    {
      id: "backtests",
      heading: "Backtests and simulated results",
      paragraphs: [
        "Backtest results are hypothetical. No trade described by a backtest was placed, and no result reported by one was earned.",
        "A result depends on the securities in the selected list, the membership periods recorded for them, the historical data available, the configured capital, contributions and position limits, and the execution methodology recorded in the run. Only the costs and assumptions that methodology describes are included; anything it does not describe is not modelled.",
        "Real trading can differ because of liquidity, the prices at which orders actually fill, transaction costs, taxes, market conditions and other factors.",
        "A list assembled from today's securities can carry selection and survivorship bias, because securities that ceased to exist are not in it. Membership periods you supply constrain when a security may be bought in a simulation; they are not evidence that a historical index membership has been reconstructed completely.",
        "Past performance and simulated performance do not guarantee future returns. Investing involves the risk of loss, including the loss of the amount invested.",
      ],
    },
    {
      id: "responsibility",
      heading: "Your decisions, and the limits of ours",
      paragraphs: [
        "You are responsible for your own investment decisions and for deciding whether any output of this service is appropriate for you. Consider taking independent professional advice.",
        "To the extent applicable law permits, FactorSage excludes liability for investment losses arising from reliance on its data, model estimates, strategy outputs or simulated results.",
        "Nothing in this notice excludes or limits liability that cannot lawfully be excluded or limited, and nothing in it affects mandatory consumer rights. A disclaimer does not remove any obligation this service has to work as described or to be fixed when it does not.",
      ],
    },
  ],
};

const TERMS: LegalDocument = {
  kind: "TERMS",
  route: "/terms",
  title: "Terms of Service",
  summary:
    "The contract between you and the operator of FactorSage. The Risk Disclosure forms part of it.",
  version: DRAFT_VERSION,
  effectiveDate: DRAFT_DATE,
  status: "DRAFT",
  contentHash: "",
  sections: [
    {
      id: "operator",
      heading: "Who you are contracting with",
      paragraphs: [
        "FactorSage is operated by {{LEGAL_ENTITY_NAME}}, registered at {{REGISTERED_ADDRESS}}, registration {{REGISTRATION_IDENTIFIER}}, tax identification {{TAX_IDENTIFIER}}.",
        "Support and complaints: {{SUPPORT_CONTACT}}. Privacy requests: {{PRIVACY_CONTACT}}.",
        "These terms govern your use of FactorSage's research, valuation, strategy, backtesting and monitoring features. The Risk Disclosure forms part of these terms, and the Privacy Policy explains how personal data is handled.",
      ],
      pending: {
        ownerInput: "O1",
        note: "The contracting entity, its registered address and its registration and tax identifiers are not yet supplied and are not invented here.",
      },
    },
    {
      id: "accounts",
      heading: "Accounts and acceptable use",
      paragraphs: [
        "You need an account for most features. Keep your sign-in credentials secure, give accurate account information, and tell us if you believe someone else has used your account.",
        "You must have the legal capacity to enter into this contract.",
      ],
      list: [
        "Do not attempt unauthorised access to the service, to another account, or to any system it runs on.",
        "Do not interfere with the operation of the service or with other users' use of it.",
        "Do not circumvent technical limits, plan limits or access controls.",
        "Do not use the service for anything unlawful.",
        "Automated access, bulk extraction and redistribution of market data are permitted only to the extent the service expressly provides for them and applicable data licences allow.",
      ],
      pending: {
        ownerInput: "O3",
        note: "Minimum age, the markets served and whether the service is offered to consumers, to businesses or to both are not yet decided, and they change what this section must say.",
      },
    },
    {
      id: "service",
      heading: "The service, plans and payment",
      paragraphs: [
        "Available features and usage limits are those described in the plan information shown in the product. We may change the features of a plan; where a change materially reduces what you have paid for, your rights under applicable consumer law are unaffected.",
        "Before you pay, the product shows the plan, the billing interval, the amount payable in the stated currency including applicable taxes, and when it renews. An annual plan is presented as its annual amount.",
        "Subscriptions renew automatically at the then-current price for the plan until cancelled. Cancelling a renewal stops the next charge and normally leaves your access in place until the end of the period you have already paid for; the effective date is shown before you confirm.",
        "Cancelling a renewal is a separate thing from a statutory right of withdrawal and from a claim that the service does not conform to the contract. Cancellation and refunds explains all three.",
      ],
      pending: {
        ownerInput: "O8",
        note: "Tax treatment, whether displayed amounts are tax-inclusive for each market, and invoice handling are not yet confirmed with the operator's accountant.",
      },
    },
    {
      id: "data-and-outputs",
      heading: "Data, simulations and what the service does not promise",
      paragraphs: [
        "FactorSage is a research and analysis tool. It does not provide investment advice, and its outputs are not recommendations. The Risk Disclosure sets out in full what market data, valuations, strategy signals and backtests are, and what their limits are; it forms part of these terms.",
        "This section does not remove the obligation for the service to be as described and to work as a service of this kind should. Where applicable law gives you remedies for a service that does not conform to the contract, those remedies apply.",
      ],
    },
    {
      id: "user-content",
      heading: "What you create in the product",
      paragraphs: [
        "Stock lists, strategies, backtest configurations and monitors you create remain yours. You grant the operator only the permissions needed to host, process, display and back up that content so the service can run for you.",
        "Built-in content provided with the product, and the software, design and documentation of the service, remain the operator's or its licensors' property.",
      ],
      pending: {
        ownerInput: "O11",
        note: "Whether the market-data licence permits commercial display, derived outputs, retention and any required attribution has not been confirmed, and this section cannot state licence terms that have not been read.",
      },
    },
    {
      id: "availability",
      heading: "Availability, maintenance and changes",
      paragraphs: [
        "The service is provided on an ongoing basis and may be interrupted for maintenance, for changes, or by faults. No specific uptime figure is promised here, and none should be read into this document.",
        "We may change these terms. You will be given notice of a material change before it takes effect, and it will apply from that date rather than retrospectively. Where applicable law requires your agreement to a material change, your continued use alone is not treated as that agreement.",
      ],
    },
    {
      id: "suspension",
      heading: "Suspension and termination",
      paragraphs: [
        "You may stop using the service at any time and may cancel a subscription renewal from Billing.",
        "Access may be suspended or ended where it is necessary and proportionate — for example for a serious or repeated breach of the acceptable-use rules above, or where the law requires it. Where it is practicable and lawful to do so, you will be told why and given the chance to respond, and you may contact {{SUPPORT_CONTACT}} to challenge it.",
        "Suspension or termination does not remove your right to a refund of amounts you are entitled to under applicable law.",
      ],
    },
    {
      id: "liability",
      heading: "Liability",
      paragraphs: [
        "To the extent applicable law permits, the operator excludes liability for investment losses that result from reliance on market data, model estimates, strategy outputs or simulated results produced by the service.",
        "Nothing in these terms excludes or limits liability that cannot lawfully be excluded or limited. Depending on applicable law that includes, among others, liability for death or personal injury caused by negligence, for fraud or fraudulent misrepresentation, and for intentional misconduct or gross negligence. Your mandatory rights as a consumer are unaffected.",
      ],
      pending: {
        ownerInput: "O9",
        note: "The scope of recoverable loss, whether any monetary cap is proposed and whether it would be enforceable, and the governing-law and jurisdiction wording, are all for counsel. No cap and no indemnity against consumer claims is asserted here, and this clause must not be described as enforceable protection until it has been reviewed.",
      },
    },
    {
      id: "complaints",
      heading: "Complaints, governing law and disputes",
      paragraphs: [
        "Complaints can be sent to {{COMPLAINTS_CONTACT}}. We will confirm that a complaint has been received and tell you how it will be handled.",
        "Governing law and jurisdiction: {{GOVERNING_LAW}}. Mandatory consumer protections and the right to bring proceedings in the courts of your own country of residence, where applicable law gives it to you, are unaffected.",
        "Alternative dispute resolution: {{ADR_INFORMATION}}.",
      ],
      pending: {
        ownerInput: "O12",
        note: "The applicable dispute-resolution body and its current contact details must be verified for this operator. Obsolete boilerplate links are deliberately not reproduced.",
      },
    },
  ],
};

const PRIVACY: LegalDocument = {
  kind: "PRIVACY",
  route: "/privacy",
  title: "Privacy Policy",
  summary:
    "What personal data FactorSage processes, why, and what you can ask for. Information, not a consent.",
  version: DRAFT_VERSION,
  effectiveDate: DRAFT_DATE,
  status: "DRAFT",
  contentHash: "",
  sections: [
    {
      id: "controller",
      heading: "Who is responsible",
      paragraphs: [
        "The controller for the processing described here is {{LEGAL_ENTITY_NAME}}, {{REGISTERED_ADDRESS}}. Privacy requests and questions: {{PRIVACY_CONTACT}}.",
        "This notice is information. Reading it is not consent, and accepting the Terms of Service is not consent to every purpose described here — most processing below rests on performing the contract or on a legal obligation, and the few things that need consent are asked for separately.",
      ],
      pending: {
        ownerInput: "O1",
        note: "Controller identity and address are outstanding. Whether a data protection officer is appointed or required is part of the same review.",
      },
    },
    {
      id: "account",
      heading: "Account data",
      paragraphs: [
        "Your email address, and — if you use a password — a cryptographic hash of that password rather than the password itself. If you sign in with Google, the identifier Google issues for your account and the verified address it reports.",
        "Also: whether and when the address was verified, when an activation or recovery email was last requested for it, and a counter used to end existing sessions when a credential changes.",
        "Purpose: creating and securing your account and signing you in. Basis: performing the contract you asked for, and the operator's legitimate interest in keeping accounts secure.",
      ],
    },
    {
      id: "product",
      heading: "What you create in the product",
      paragraphs: [
        "Stock lists and their membership periods, strategies and their versions, backtest configurations and the immutable snapshots and results of each run, monitors and the signals they produce, your recently viewed securities, and your visibility preferences for built-in monitors.",
        "Purpose: providing the features you use. Basis: performing the contract.",
      ],
    },
    {
      id: "security",
      heading: "Security and operational data",
      paragraphs: [
        "Server logs recording requests and application events, correlated by a request identifier and, for a signed-in caller, by the internal user identifier. Rate-limit counters keyed by user identifier or by client IP address.",
        "Passwords, cookies, authorisation headers, session tokens and API keys are not written to logs.",
        "Purpose: operating the service, diagnosing faults and protecting it from abuse. Basis: legitimate interest in a service that works and is not abused, and legal obligation where one applies.",
      ],
    },
    {
      id: "billing",
      heading: "Billing data",
      paragraphs: [
        "If you buy a subscription, the identifiers of your customer and subscription records with the payment provider, and the mirrored state of that subscription: its plan, interval, status, period end and any scheduled change.",
        "Payment card details are entered on the payment provider's own hosted pages and are not received or stored by FactorSage.",
      ],
      pending: {
        ownerInput: "O4",
        note: "The payment provider's role for each activity — and the roles, regions, agreements and transfer safeguards of every other supplier — must be taken from the executed contracts. This notice will not assert that every provider is a processor, nor that processing is EU-only, without that evidence.",
      },
    },
    {
      id: "acceptance",
      heading: "Legal acceptance records",
      paragraphs: [
        "When you accept the Terms of Service, FactorSage records your account identifier, which document and version you accepted, a digest of the exact text of that version, whether the record is an acceptance or a notice that was shown to you, the surface you accepted on, and the server time.",
        "It deliberately does not record your IP address or your browser's user-agent string for this purpose.",
        "Purpose: evidence that a contract was formed and of what its terms were. Basis: performing the contract and complying with legal obligations.",
      ],
    },
    {
      id: "requests",
      heading: "Requests you submit",
      paragraphs: [
        "If you submit a privacy request, a withdrawal request, a nonconformity report or a support request through the product, FactorSage stores the kind of request, the text you wrote, a reference, and the time it was submitted, linked to your account.",
      ],
    },
    {
      id: "recipients",
      heading: "Recipients and transfers",
      paragraphs: [
        "Personal data is handled by the operator and by the suppliers that host the service, deliver its email, provide identity sign-in and process payments.",
      ],
      pending: {
        ownerInput: "O4",
        note: "Naming those suppliers, their roles, the countries data is processed in and the safeguards for any transfer outside the EEA requires the executed agreements. They are not listed here until they are read. 'We never share your data' is not written here, because providers do receive it.",
      },
    },
    {
      id: "retention",
      heading: "How long data is kept",
      paragraphs: [
        "Account and product data is kept while the account exists. Some records — billing and accounting evidence, and evidence of contract formation — must be kept for a period applicable law fixes, even after an account closes.",
      ],
      pending: {
        ownerInput: "O5",
        note: "The retention period or objective criterion for each category, and the handling of dormant accounts, logs, backups and legal holds, are not decided. Plausible-sounding durations such as 30 or 90 days are deliberately not invented.",
      },
    },
    {
      id: "rights",
      heading: "Your rights",
      paragraphs: [
        "Subject to the conditions applicable law attaches to each of them, you may ask for access to your personal data, for its correction, for its erasure, for processing to be restricted, for a copy in a portable format, and you may object to processing based on legitimate interests. Where processing rests on consent, you may withdraw that consent at any time, and withdrawing it does not affect what was done before.",
        "Use Privacy and data requests inside the product, or write to {{PRIVACY_CONTACT}}. A request is answered within the period applicable law allows; where an extension is permitted, you will be told about it and why.",
        "Submitting a request is not the same as the request having been carried out. The product records that your request arrived and gives you a reference; it does not delete anything on its own, and it will not report data as erased when it has not been.",
        "Identity documents are not requested by default. Where a request is made from your signed-in account, that is normally verification enough.",
      ],
    },
    {
      id: "complaints",
      heading: "Complaints to a supervisory authority",
      paragraphs: [
        "You may complain to a data-protection supervisory authority, in particular in the country where you live or work. Competent authority: {{SUPERVISORY_AUTHORITY}}.",
      ],
    },
    {
      id: "other",
      heading: "Other disclosures",
      paragraphs: [
        "An email address is required to have an account; without one there is no account. Everything else you provide is optional and is what you choose to create in the product.",
        "FactorSage does not make decisions about you by automated means that produce legal effects for you or similarly significantly affect you, and it does not build advertising or behavioural profiles. Strategy evaluation is applied to securities, not to people.",
        "There is no marketing email and no newsletter. If one is ever introduced it will need its own separate opt-in; accepting the Terms of Service does not authorise it.",
      ],
    },
  ],
};

const COOKIES: LegalDocument = {
  kind: "COOKIES",
  route: "/cookies",
  title: "Cookies and browser storage",
  summary:
    "Everything FactorSage stores in your browser, why, and how to change your choice.",
  version: DRAFT_VERSION,
  effectiveDate: DRAFT_DATE,
  status: "DRAFT",
  contentHash: "",
  sections: [
    {
      id: "how-we-categorise",
      heading: "How these are categorised",
      paragraphs: [
        "Necessary storage is what the service cannot do without: keeping you signed in, completing a sign-in safely, and remembering the storage choice you made. It is used without asking, because asking for permission to honour your own choice would be circular.",
        "Optional storage is everything else, however small. FactorSage treats convenience storage as optional rather than necessary, which is why the recently-viewed list a signed-out visitor builds up is behind a choice.",
        "Nothing optional is read or written before you allow it. Before you decide, a recently-viewed list is held in memory for the current page session only and nothing is written to this browser.",
      ],
    },
    {
      id: "inventory",
      heading: "The inventory",
      paragraphs: [
        "The table on this page is generated from the application's own inventory, so it describes what the code actually does rather than what a template assumes. Each entry names the evidence it comes from.",
      ],
      pending: {
        ownerInput: "O6",
        note: "This inventory was verified against this build in a browser. A deployed environment can differ — a proxy, a CDN, a hosted payment page or a tag manager added later can all set storage this list does not know about — so it must be re-verified against the production deployment before publication.",
      },
    },
    {
      id: "third-party-pages",
      heading: "Pages that are not ours",
      paragraphs: [
        "Signing in with Google sends you to Google's own pages, and paying sends you to the payment provider's own hosted pages. Those pages are operated by those companies under their own policies and set their own cookies.",
        "The controls on this page apply to FactorSage's own pages. They do not, and cannot, control what a third party does on its own domain, and this notice does not claim otherwise.",
      ],
    },
    {
      id: "changing-your-choice",
      heading: "Changing or withdrawing your choice",
      paragraphs: [
        "Storage settings on this page lets you change your choice at any time, and withdrawing permission is the same single action as giving it.",
        "When you withdraw permission, FactorSage stops reading and writing the optional keys it controls and removes the ones it wrote. It does not clear your sign-in session or anything else unrelated.",
        "If your browser blocks site data, the product carries on without it: the choice simply cannot be remembered between visits, and nothing optional is used.",
      ],
    },
  ],
};

const CANCELLATION_AND_REFUNDS: LegalDocument = {
  kind: "CANCELLATION_AND_REFUNDS",
  route: "/cancellation-and-refunds",
  title: "Cancellation and refunds",
  summary:
    "Three different things: stopping a renewal, a statutory right of withdrawal, and a claim that the service is faulty.",
  version: DRAFT_VERSION,
  effectiveDate: DRAFT_DATE,
  status: "DRAFT",
  contentHash: "",
  sections: [
    {
      id: "overview",
      heading: "Three separate things",
      paragraphs: [
        "These are often confused, and they have different rules and different outcomes. Cancelling a renewal is a change to a future charge. A statutory withdrawal is a consumer right to step out of a distance contract within a period the law fixes. A nonconformity claim is what you have when the service does not do what it is supposed to do — and it does not expire when a withdrawal period does.",
        "There is no blanket policy treating every payment as final, and nothing in the signup flow asks you to give up a right you have by law.",
      ],
    },
    {
      id: "cancel-renewal",
      heading: "1. Cancelling a renewal",
      paragraphs: [
        "Manage your subscription in Billing. Cancelling a renewal stops the next charge; access normally continues until the end of the period you have already paid for, and the effective date is shown before you confirm.",
        "Cancelling a renewal is not a withdrawal, is not a refund request, and does not by itself return any money.",
      ],
    },
    {
      id: "withdrawal",
      heading: "2. Statutory right of withdrawal",
      paragraphs: [
        "Depending on where you live and on how this contract is classified, you may have a statutory right to withdraw from a distance contract within a period the law fixes.",
        "You can submit a withdrawal request from inside the product, from Cancellation and refunds while you are signed in. The request identifies your account and your current subscription, shows you what you are about to submit, asks you to confirm it, and gives you an immediate receipt with a reference, the submission time and the text you submitted. Keep or print that receipt.",
        "A receipt confirms that your request arrived. It is not a decision on the request, and it is not a statement that any money has been returned.",
        "If you cannot sign in, write to {{SUPPORT_CONTACT}} instead; losing a password must not stop you submitting in time. If the product is unavailable, the same address is the fallback.",
      ],
      pending: {
        ownerInput: "O7",
        note: "Whether the right applies to this service and to you, when the period starts and ends, what happens if you asked for the service to begin during it, what may lawfully be deducted, the model withdrawal form, and whether the 2026 EU online withdrawal-function requirement applies as transposed locally — all of these are for Romanian consumer-law counsel. The product therefore accepts and acknowledges requests and does not decide them, calculate a refund, or state an eligibility rule it has not been given.",
      },
    },
    {
      id: "nonconformity",
      heading: "3. If the service does not work as it should",
      paragraphs: [
        "If the service does not meet what was agreed or what applicable law requires of it, tell us. Use Report a problem with the service inside the product, or write to {{SUPPORT_CONTACT}}.",
        "These rights are separate from the two above. They are not removed by the renewal-cancellation policy, and they do not disappear when a withdrawal period ends.",
      ],
    },
    {
      id: "how-money-moves",
      heading: "How any refund would be made",
      paragraphs: [
        "Any refund that is due is made through the original payment provider, back to the original payment method. FactorSage does not calculate refund amounts by itself and does not change your plan directly; the plan follows the subscription state the payment provider reports.",
        "Submitting the same request twice does not duplicate anything: each submission is recorded with its own reference, and no money moves because a request was submitted.",
      ],
      pending: {
        ownerInput: "O2",
        note: "A monitored operator mailbox, the person responsible for handling these requests and the deadlines they work to are not yet assigned. Until they are, the product acknowledges receipt on screen and stores the request; it does not promise a response time and does not send a confirmation email it has no address to send from.",
      },
    },
  ],
};

const CONTACT: LegalDocument = {
  kind: "CONTACT",
  route: "/contact",
  title: "Contact and legal information",
  summary: "Who operates FactorSage, and how to reach them.",
  version: DRAFT_VERSION,
  effectiveDate: DRAFT_DATE,
  status: "DRAFT",
  contentHash: "",
  sections: [
    {
      id: "operator",
      heading: "Operator",
      paragraphs: [
        "Product: FactorSage.",
        "Operator: {{LEGAL_ENTITY_NAME}}.",
        "Registered address: {{REGISTERED_ADDRESS}}.",
        "Registration: {{REGISTRATION_IDENTIFIER}}.",
        "Tax identification: {{TAX_IDENTIFIER}}.",
      ],
      pending: {
        ownerInput: "O1",
        note: "These identifying details have not been supplied and are deliberately not invented. A paid service may not be launched publicly without them.",
      },
    },
    {
      id: "channels",
      heading: "How to reach us",
      paragraphs: [
        "Support and general questions: {{SUPPORT_CONTACT}}.",
        "Privacy and data-protection requests: {{PRIVACY_CONTACT}}.",
        "Complaints: {{COMPLAINTS_CONTACT}}.",
        "Signed-in users can also submit a privacy request, a withdrawal request, a nonconformity report or a support request from inside the product, and receive an immediate on-screen receipt with a reference.",
      ],
      pending: {
        ownerInput: "O2",
        note: "None of these mailboxes is monitored yet, and no response time is promised. A link is not an operational channel.",
      },
    },
    {
      id: "complaints",
      heading: "Complaints and dispute resolution",
      paragraphs: [
        "If a complaint is not resolved, alternative dispute resolution may be available: {{ADR_INFORMATION}}.",
        "For data-protection matters you may also complain to a supervisory authority: {{SUPERVISORY_AUTHORITY}}.",
      ],
      pending: {
        ownerInput: "O12",
        note: "The applicable consumer dispute-resolution mechanism and its current details must be verified for this operator and this market before publication.",
      },
    },
  ],
};

/**
 * Every document, keyed by kind. The one registry: a page, the acceptance recorder and the
 * readiness check all read this and there is no second copy of a document anywhere.
 */
export const LEGAL_DOCUMENTS: Readonly<
  Record<LegalDocumentKind, LegalDocument>
> = {
  TERMS: withHash(TERMS),
  PRIVACY: withHash(PRIVACY),
  COOKIES: withHash(COOKIES),
  RISK_DISCLOSURE: withHash(RISK_DISCLOSURE),
  CANCELLATION_AND_REFUNDS: withHash(CANCELLATION_AND_REFUNDS),
  CONTACT: withHash(CONTACT),
};

export const LEGAL_DOCUMENT_LIST: readonly LegalDocument[] =
  Object.values(LEGAL_DOCUMENTS);

export function legalDocument(kind: LegalDocumentKind): LegalDocument {
  return LEGAL_DOCUMENTS[kind];
}

/**
 * Attaches the pinned digest for a document.
 *
 * The digest is not computed here: this module is bundled for the browser, where `node:crypto`
 * does not exist and `crypto.subtle` is asynchronous. It is pinned in the table below and
 * recomputed by `legal-documents.test.ts`, which fails on a mismatch **or on an empty value** —
 * so a document added without running `pnpm legal:hashes` fails the build rather than shipping.
 *
 * An empty hash is returned rather than thrown so the hash tool itself can import this registry;
 * the API separately refuses to record an acceptance against a document with no digest, because
 * an acceptance that cannot resolve to a text is not evidence of anything.
 */
function withHash(document: LegalDocument): LegalDocument {
  return {
    ...document,
    contentHash:
      LEGAL_DOCUMENT_CONTENT_HASHES[`${document.kind}@${document.version}`] ??
      "",
  };
}

export { canonicalLegalDocumentText };
