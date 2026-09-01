/**
 * Outbound email boundary.
 *
 * Business code depends on this port only, so integration tests replace the whole transport with
 * an in-memory fake and no automated test can reach a real mail server.
 */
export type EmailMessage = {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
};

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

export const EMAIL_SENDER = Symbol("EMAIL_SENDER");

export class EmailTransportUnavailableError extends Error {
  constructor() {
    super("Email transport is not configured");
    this.name = "EmailTransportUnavailableError";
  }
}

/**
 * Installed when no SMTP transport is configured.
 *
 * Failing loudly at send time keeps the API bootable without mail infrastructure while making it
 * impossible to believe a verification email was delivered when nothing was sent.
 */
export class UnconfiguredEmailSender implements EmailSender {
  send(): Promise<void> {
    return Promise.reject(new EmailTransportUnavailableError());
  }
}
