import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    // Component behaviour (focus, keyboard, outside clicks) is the point of the web suite, so the
    // default node environment is not enough. Pure module tests run fine under jsdom too.
    environment: "jsdom",
    globals: false,
    setupFiles: ["./vitest.setup.ts"],
    // `qa/` holds the manual QA-persona launcher; its argument parsing is unit-tested here.
    include: ["src/**/*.test.{ts,tsx}", "qa/**/*.test.ts"],
  },
});
