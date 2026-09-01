import { Inject, Injectable } from "@nestjs/common";
import { AUTH_CONFIG, type AuthConfig } from "../config/configuration.module";
import { EMAIL_SENDER, type EmailSender } from "../email/email-sender";

const PRODUCT_NAME = "FactorSage";

/**
 * Composes FactorSage's account emails and hands them to the transport-agnostic email boundary.
 *
 * The verification link points at the web application, which then completes verification through
 * the API. The token appears only inside the outbound message and is never logged.
 */
@Injectable()
export class AuthEmailService {
  constructor(
    @Inject(EMAIL_SENDER) private readonly sender: EmailSender,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
  ) {}

  async sendVerificationEmail(input: {
    to: string;
    token: string;
  }): Promise<void> {
    const url = this.verificationUrl(input.token);
    const validFor = describeDuration(this.config.emailVerificationTtlSeconds);

    await this.sender.send({
      to: input.to,
      subject: `Verify your ${PRODUCT_NAME} email address`,
      text: [
        `Welcome to ${PRODUCT_NAME}.`,
        "",
        "Confirm your email address to activate your account:",
        url,
        "",
        `This link is valid for ${validFor} and can be used once.`,
        "If you did not create this account you can ignore this email.",
      ].join("\n"),
      html: [
        `<p>Welcome to ${PRODUCT_NAME}.</p>`,
        "<p>Confirm your email address to activate your account:</p>",
        `<p><a href="${url}">${url}</a></p>`,
        `<p>This link is valid for ${validFor} and can be used once.</p>`,
        "<p>If you did not create this account you can ignore this email.</p>",
      ].join("\n"),
    });
  }

  private verificationUrl(token: string): string {
    // base64url tokens contain no characters that need escaping, but encoding keeps the link
    // correct if the token alphabet ever changes.
    return `${this.config.webBaseUrl}/verify-email?token=${encodeURIComponent(token)}`;
  }
}

function describeDuration(seconds: number): string {
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return hours === 1 ? "1 hour" : `${hours} hours`;
  }
  const minutes = Math.max(1, Math.round(seconds / 60));
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}
