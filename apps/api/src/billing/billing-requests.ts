import {
  BILLING_PRICE_KEYS,
  isBillingPriceKey,
  type BillingPriceKey,
} from "@intrinsic/contracts";
import { BadRequestException } from "@nestjs/common";

/**
 * Envelope parsing for the billing routes.
 *
 * Hand-written, matching the repository's existing approach — there is no validation library in the
 * workspace and none should be added.
 *
 * **Rejecting unknown keys is the security boundary here, not tidiness.** `docs/decisions/
 * stripe-billing-v1.md` section 21 forbids a client choosing a Stripe price, customer, subscription,
 * plan or role. This function is what makes that structural: `priceId`, `stripePriceId`,
 * `customerId`, `subscriptionId`, `plan` and `role` are not merely ignored — a request carrying any
 * of them is refused, because a silently dropped field looks to a client exactly like an accepted
 * one, and the next person to add a field would not know it must not be read.
 *
 * The only accepted input in the whole billing surface is one of four logical catalog keys.
 */

const ALLOWED_KEYS = ["priceKey"] as const;

function asRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BadRequestException("Invalid request body");
  }
  return body as Record<string, unknown>;
}

/** Named explicitly so the refusal says *why*, rather than "unknown field". */
const CLIENT_CONTROLLED_BILLING_FIELDS = new Set([
  "priceId",
  "stripePriceId",
  "price",
  "customerId",
  "stripeCustomerId",
  "subscriptionId",
  "stripeSubscriptionId",
  "plan",
  "role",
  "amount",
  "successUrl",
  "cancelUrl",
  "returnUrl",
]);

export function parseBillingTargetRequest(body: unknown): {
  readonly priceKey: BillingPriceKey;
} {
  const record = asRecord(body);

  for (const key of Object.keys(record)) {
    if ((ALLOWED_KEYS as readonly string[]).includes(key)) {
      continue;
    }
    if (CLIENT_CONTROLLED_BILLING_FIELDS.has(key)) {
      throw new BadRequestException(
        `Invalid request: \`${key}\` is decided by the server, not the client. Send only ` +
          `\`priceKey\`, one of ${BILLING_PRICE_KEYS.join(", ")}.`,
      );
    }
    throw new BadRequestException(
      `Invalid request: \`${key}\` is not part of a billing request.`,
    );
  }

  if (!isBillingPriceKey(record.priceKey)) {
    throw new BadRequestException(
      `Invalid request: priceKey must be one of ${BILLING_PRICE_KEYS.join(", ")}`,
    );
  }

  return { priceKey: record.priceKey };
}
