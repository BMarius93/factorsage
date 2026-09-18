import { Inject, Injectable } from "@nestjs/common";
import { AUTH_CONFIG, type AuthConfig } from "../config/configuration.module";
import { EMAIL_SENDER, type EmailSender } from "../email/email-sender";

const PRODUCT_NAME = "FactorSage";

/**
 * Composes FactorSage's account emails and hands them to the transport-agnostic email boundary.
 *
 * Both account links point at the web application, which then completes the action through the
 * API. A token appears only inside the outbound message and is never logged.
 */
@Injectable()
export class AuthEmailService {
  constructor(
    @Inject(EMAIL_SENDER) private readonly sender: EmailSender,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
  ) {}

  /**
   * The activation link (AUTH-003): the only way a first password is ever set.
   *
   * Anyone can type an address into registration, so this message goes to people who asked for
   * nothing. It therefore says plainly that it can be ignored, and that ignoring it leaves nothing
   * usable behind. It carries no password and no account detail.
   */
  async sendVerificationEmail(input: {
    to: string;
    token: string;
  }): Promise<void> {
    const url = this.verificationUrl(input.token);
    const validFor = describeDuration(this.config.emailVerificationTtlSeconds);

    await this.sender.send({
      to: input.to,
      subject: `Finish creating your ${PRODUCT_NAME} account`,
      text: [
        `Someone asked to create a ${PRODUCT_NAME} account with this email address.`,
        "",
        "If it was you, confirm the address and choose your password here:",
        url,
        "",
        `This link is valid for ${validFor} and can be used once.`,
        "If it was not you, ignore this email. No account can be used without this link.",
      ].join("\n"),
      html: [
        `<p>Someone asked to create a ${PRODUCT_NAME} account with this email address.</p>`,
        "<p>If it was you, confirm the address and choose your password here:</p>",
        `<p><a href="${url}">${url}</a></p>`,
        `<p>This link is valid for ${validFor} and can be used once.</p>`,
        "<p>If it was not you, ignore this email. No account can be used without this link.</p>",
      ].join("\n"),
    });
  }

  /**
   * Sent instead of an activation link when registration is asked for an address that already has
   * a verified account (AUTH-003, DEC-004).
   *
   * The public response is the same as for a new address, so this is the only place the owner
   * learns that the address is taken — and they already know. It contains **no token and no
   * link that changes anything**: it points at sign-in, and at recovery when the account has a
   * password. It says how the account signs in because only the mailbox owner reads it.
   */
  async sendExistingAccountNotice(input: {
    to: string;
    methods: { readonly password: boolean; readonly google: boolean };
  }): Promise<void> {
    const loginUrl = `${this.config.webBaseUrl}/login`;
    const recoveryUrl = `${this.config.webBaseUrl}/forgot-password`;
    const text: string[] = [
      `Someone asked to create a ${PRODUCT_NAME} account with this email address, but it already has one. Nothing about your account has changed.`,
      "",
    ];
    const html: string[] = [
      `<p>Someone asked to create a ${PRODUCT_NAME} account with this email address, but it already has one. Nothing about your account has changed.</p>`,
    ];

    if (input.methods.password) {
      text.push(
        `Sign in with your email address and password: ${loginUrl}`,
        `Forgot your password? Reset it here: ${recoveryUrl}`,
      );
      html.push(
        `<p>Sign in with your email address and password: <a href="${loginUrl}">${loginUrl}</a></p>`,
        `<p>Forgot your password? Reset it here: <a href="${recoveryUrl}">${recoveryUrl}</a></p>`,
      );
    }
    if (input.methods.google) {
      text.push(`Your account signs in with Google: ${loginUrl}`);
      html.push(
        `<p>Your account signs in with Google: <a href="${loginUrl}">${loginUrl}</a></p>`,
      );
    }
    if (!input.methods.password && !input.methods.google) {
      text.push(`Sign in here: ${loginUrl}`);
      html.push(`<p>Sign in here: <a href="${loginUrl}">${loginUrl}</a></p>`);
    }

    text.push("", "If this was not you, you can ignore this email.");
    html.push("<p>If this was not you, you can ignore this email.</p>");

    await this.sender.send({
      to: input.to,
      subject: `You already have a ${PRODUCT_NAME} account`,
      text: text.join("\n"),
      html: html.join("\n"),
    });
  }

  /**
   * The reset link.
   *
   * The message names the product and says plainly that an unrequested link can be ignored,
   * because this email is the one an attacker probing addresses would cause to be delivered to a
   * stranger. It carries no account detail — no name, no plan, no sign-in history — and the token
   * appears only here, never in a log.
   */
  async sendPasswordResetEmail(input: {
    to: string;
    token: string;
  }): Promise<void> {
    const url = this.passwordResetUrl(input.token);
    const validFor = describeDuration(this.config.passwordResetTtlSeconds);

    await this.sender.send({
      to: input.to,
      subject: `Reset your ${PRODUCT_NAME} password`,
      text: [
        `A password reset was requested for your ${PRODUCT_NAME} account.`,
        "",
        "Choose a new password here:",
        url,
        "",
        `This link is valid for ${validFor} and can be used once.`,
        "If you did not request it, you can ignore this email and your password stays unchanged.",
      ].join("\n"),
      html: [
        `<p>A password reset was requested for your ${PRODUCT_NAME} account.</p>`,
        "<p>Choose a new password here:</p>",
        `<p><a href="${url}">${url}</a></p>`,
        `<p>This link is valid for ${validFor} and can be used once.</p>`,
        "<p>If you did not request it, you can ignore this email and your password stays unchanged.</p>",
      ].join("\n"),
    });
  }

  private verificationUrl(token: string): string {
    // base64url tokens contain no characters that need escaping, but encoding keeps the link
    // correct if the token alphabet ever changes.
    return `${this.config.webBaseUrl}/verify-email?token=${encodeURIComponent(token)}`;
  }

  private passwordResetUrl(token: string): string {
    return `${this.config.webBaseUrl}/reset-password?token=${encodeURIComponent(token)}`;
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
