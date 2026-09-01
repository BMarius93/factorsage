import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Every component test mounts into the same jsdom document; without this a later test can find a
// previous test's markup and pass for the wrong reason.
afterEach(() => {
  cleanup();
});

// jsdom does not implement the native <dialog> methods. The polyfill only mirrors the `open`
// state the components rely on; top-layer and focus-trap behaviour stays a real-browser concern.
if (typeof HTMLDialogElement !== "undefined") {
  HTMLDialogElement.prototype.showModal ??= function showModal(
    this: HTMLDialogElement,
  ) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function close(
    this: HTMLDialogElement,
  ) {
    this.open = false;
  };
}
