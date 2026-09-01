import type { EmailMessage, EmailSender } from "./email-sender";

/**
 * Test double for the email boundary.
 *
 * Integration tests replace `EMAIL_SENDER` with this implementation, which is why no automated
 * test needs SMTP credentials or can deliver mail to a real address.
 */
export class InMemoryEmailSender implements EmailSender {
  readonly messages: EmailMessage[] = [];

  /** When set, the next send rejects with this error so failure paths can be exercised. */
  failWith: Error | null = null;

  send(message: EmailMessage): Promise<void> {
    if (this.failWith) {
      return Promise.reject(this.failWith);
    }
    this.messages.push(message);
    return Promise.resolve();
  }

  get lastMessage(): EmailMessage | undefined {
    return this.messages.at(-1);
  }

  reset(): void {
    this.messages.length = 0;
    this.failWith = null;
  }
}
