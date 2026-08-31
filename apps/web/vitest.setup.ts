import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Every component test mounts into the same jsdom document; without this a later test can find a
// previous test's markup and pass for the wrong reason.
afterEach(() => {
  cleanup();
});
