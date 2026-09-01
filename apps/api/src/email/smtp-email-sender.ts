import type { SmtpConfig } from "@intrinsic/config";
import { createTransport, type Transporter } from "nodemailer";
import type { EmailMessage, EmailSender } from "./email-sender";

/**
 * SMTP transport for the email boundary.
 *
 * Credentials are optional so an unauthenticated local relay (Mailpit, MailHog) and an
 * authenticated production relay use the same code path.
 */
export class SmtpEmailSender implements EmailSender {
  private readonly transporter: Transporter;

  constructor(private readonly config: SmtpConfig) {
    this.transporter = createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      ...(config.auth
        ? { auth: { user: config.auth.user, pass: config.auth.password } }
        : {}),
    });
  }

  async send(message: EmailMessage): Promise<void> {
    await this.transporter.sendMail({
      from: this.config.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  }
}
