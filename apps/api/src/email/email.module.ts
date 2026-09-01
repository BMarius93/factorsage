import { getSmtpConfig } from "@intrinsic/config";
import { Module } from "@nestjs/common";
import {
  EMAIL_SENDER,
  type EmailSender,
  UnconfiguredEmailSender,
} from "./email-sender";
import { SmtpEmailSender } from "./smtp-email-sender";

@Module({
  providers: [
    {
      provide: EMAIL_SENDER,
      useFactory: (): EmailSender => {
        const smtp = getSmtpConfig();
        return smtp ? new SmtpEmailSender(smtp) : new UnconfiguredEmailSender();
      },
    },
  ],
  exports: [EMAIL_SENDER],
})
export class EmailModule {}
