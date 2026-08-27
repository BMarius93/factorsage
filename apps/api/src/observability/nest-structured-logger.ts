import type { LoggerService } from "@nestjs/common";
import type { LogFields, StructuredLogger } from "@intrinsic/observability";

export class NestStructuredLogger implements LoggerService {
  constructor(private readonly logger: StructuredLogger) {}

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.info(this.fields("nestjs.log", message, optionalParams), text(message));
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.error(
      this.fields("nestjs.error", message, optionalParams),
      text(message),
    );
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.warn(this.fields("nestjs.warn", message, optionalParams), text(message));
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.debug(
      this.fields("nestjs.debug", message, optionalParams),
      text(message),
    );
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.trace(
      this.fields("nestjs.verbose", message, optionalParams),
      text(message),
    );
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.fatal(
      this.fields("nestjs.fatal", message, optionalParams),
      text(message),
    );
  }

  private fields(
    event: string,
    message: unknown,
    optionalParams: unknown[],
  ): LogFields {
    return {
      event,
      ...(typeof message === "string"
        ? {}
        : message instanceof Error
          ? { err: message }
          : { nestMessage: message }),
      ...(optionalParams.length > 0 ? { nestParams: optionalParams } : {}),
    };
  }
}

function text(message: unknown): string {
  if (typeof message === "string") {
    return message;
  }
  if (message instanceof Error) {
    return message.message;
  }
  return "NestJS log";
}
