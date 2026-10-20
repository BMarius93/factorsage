import { render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installFakeViewport,
  type FakeViewport,
} from "./__testing__/fake-viewport";
import { useDocumentVisible, useMediaQuery } from "./use-media-query";

function Probe() {
  const wide = useMediaQuery("(min-width: 1280px)");
  const visible = useDocumentVisible();
  return (
    <p data-testid="probe">
      {wide ? "wide" : "narrow"} {visible ? "visible" : "hidden"}
    </p>
  );
}

let viewport: FakeViewport | undefined;

afterEach(() => {
  viewport?.restore();
  viewport = undefined;
  vi.unstubAllGlobals();
});

describe("useMediaQuery", () => {
  it("answers the query and follows it across the breakpoint", () => {
    viewport = installFakeViewport({ width: 1279 });
    render(<Probe />);
    expect(screen.getByTestId("probe").textContent).toBe("narrow visible");

    viewport.resize(1280);
    expect(screen.getByTestId("probe").textContent).toBe("wide visible");

    viewport.resize(1279);
    expect(screen.getByTestId("probe").textContent).toBe("narrow visible");
  });

  it("renders the not-matching branch on the server, whatever the client will say", () => {
    viewport = installFakeViewport({ width: 1920 });
    // The server snapshot: what the server and the hydrating client both render first.
    expect(renderToString(<Probe />)).toContain("narrow");
  });

  it("is false without matchMedia rather than throwing", () => {
    vi.stubGlobal("matchMedia", undefined);
    render(<Probe />);
    expect(screen.getByTestId("probe").textContent).toBe("narrow visible");
  });

  it("removes its listener when the component unmounts", () => {
    viewport = installFakeViewport({ width: 1440 });
    const { unmount } = render(<Probe />);
    expect(viewport.listenerCount()).toBe(1);
    unmount();
    expect(viewport.listenerCount()).toBe(0);
  });
});

describe("useDocumentVisible", () => {
  it("follows the page's visibility", () => {
    viewport = installFakeViewport();
    render(<Probe />);

    viewport.setHidden(true);
    expect(screen.getByTestId("probe").textContent).toBe("wide hidden");

    viewport.setHidden(false);
    expect(screen.getByTestId("probe").textContent).toBe("wide visible");
  });
});
