import { Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { SystemContentExceptionFilter } from "./system-content.filter";

/**
 * Installs the built-in-content refusal mapping. Imported by every feature module that can change
 * a List, Strategy or Monitor, so a suite compiling only its own module maps refusals exactly as
 * the running API does.
 */
@Module({
  providers: [{ provide: APP_FILTER, useClass: SystemContentExceptionFilter }],
})
export class SystemContentModule {}
