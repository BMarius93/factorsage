# FactorSage legal and privacy implementation handoff

Status: implementation specification and draft copy; not a legal opinion or approved public policy.
Prepared: 2026-09-20. Repository baseline: `7571bba9f5ef6b9d142f8ab60de87d213471d915` (`main`).

## Owner's objective

Present FactorSage as a research, strategy-analysis and simulation tool; explain third-party data
limitations and user responsibility for investment decisions; limit liability to the extent legally
permitted. Add the legal pages, acceptance records, privacy/cookie controls and subscription
disclosures necessary to support that position. A disclaimer cannot change what the product
actually does, remove mandatory consumer rights or guarantee immunity from claims.

This commit is documentation only. None of the proposed routes, controls or persistence below
should be described as already implemented. The next agent implements on this branch; no merge
or production deployment is requested.

## Read order

1. Repository `AGENTS.md` and `ai/README.md`.
2. [Implementation specification](implementation-spec.md).
3. [Draft public copy](public-copy-drafts.md).
4. [Owner facts and legal review](owner-inputs-and-review.md).
5. [Acceptance checklist](acceptance-checklist.md).
6. [Copilot handoff](copilot-handoff.md).

The existing product/architecture ADRs remain authoritative for billing, auth, entitlements,
financial calculations and Monitor semantics. This spec adds legal UX and evidence, not a new
billing engine, financial method, tracking product, trial or subscription plan.

## Verified repository findings

| Area | Evidence at baseline | Consequence |
| --- | --- | --- |
| Registration | `apps/web/src/features/auth/components/RegisterForm.tsx`; `ai/architecture/authentication.md` | Email-first request, generic accepted response; actual password chosen at email activation. Do not attach binding acceptance to someone merely submitting another person's email. |
| Google identity | `apps/api/src/auth/google/google-auth.service.ts`; `auth.controller.ts` | Google can create/link identities. Both entry points must converge on verified legal onboarding. |
| Cookies | `apps/api/src/auth/auth-cookie.ts` | Auth cookie name and TTL are configured; OAuth cookie uses name suffix `_oauth_tx`, path `/auth`, 10-minute lifetime. Verify production config without committing secrets. |
| Guest browser storage | `apps/web/src/features/stocks/recent/utils/guest-recent-securities.ts` | `factorsage.recent-securities.v1` stores security ids in localStorage; no time-based expiry in this helper. It must be inventoried and classified. |
| Billing | `ai/architecture/billing.md`; `docs/decisions/stripe-billing-v1.md` | Hosted Stripe Checkout/Portal; existing reconciliation owns plan writes; no trials. Tax configuration needs owner review, not assumptions. |
| Layout | `apps/web/src/components/layout/AppShell.tsx`; auth components; App Router | Add consistent public legal access without breaking desktop/mobile layouts or auth redirects. |

A targeted source search found no analytics SDK reference in `apps/web/src`; this is not proof
that a deployed site, proxy, hosted payment page or tag manager performs no tracking. Complete a
runtime inventory before publishing the policy.

## Primary legal references and limits

These sources informed the planning discussion; they are not a certification of Romanian or
worldwide compliance. Confirm current versions, Romanian implementation and territorial scope
before launch, especially the 2026 withdrawal-function requirement.

- [GDPR](https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng): articles 5–7, 12–22, 28, 32, 44 onward.
- [ePrivacy Directive](https://eur-lex.europa.eu/eli/dir/2002/58/2009-12-19/eng): article 5(3), device storage/access; article 13, marketing.
- [EDPB consent guidance](https://www.edpb.europa.eu/documents/guideline/guidelines-052020-on-consent-under-regulation-2016679_en).
- [E-commerce Directive](https://eur-lex.europa.eu/eli/dir/2000/31/oj/eng): provider identity and accessible contracting information.
- [Consumer Rights Directive](https://eur-lex.europa.eu/eli/dir/2011/83/2022-05-28/eng): pre-contract information, payment acknowledgment, durable confirmation and withdrawal.
- [Directive 2023/2673](https://eur-lex.europa.eu/eli/dir/2023/2673/oj/eng): online withdrawal function; applicability/transposition review required for launch after 19 June 2026.
- [Digital Content/Services Directive](https://eur-lex.europa.eu/eli/dir/2019/770/oj/eng): conformity and mandatory remedies.
- [Unfair Terms Directive](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:31993L0013): limits on contractual exclusions.
- [Market Abuse Regulation](https://eur-lex.europa.eu/eli/reg/2014/596/oj/eng): investment recommendations, including public outputs; article 20.

Local review also covers Law 365/2002, Law 506/2004, OUG 34/2014 as amended, Romanian digital-service
and unfair-term rules, applicable ANPC/SAL information, accessibility requirements/exemptions,
language requirements, tax and invoice handling. Do not copy obsolete dispute-resolution links
from templates. Validate applicable markets beyond Romania/EEA separately.
