import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  enableBacktestShare,
  fetchBacktestShare,
  revokeBacktestShare,
} from "../api/backtests-api";
import { BacktestShareControl } from "./BacktestShareControl";

vi.mock("../api/backtests-api", () => ({
  fetchBacktestShare: vi.fn(),
  enableBacktestShare: vi.fn(),
  revokeBacktestShare: vi.fn(),
}));

const fetchShareMock = vi.mocked(fetchBacktestShare);
const enableMock = vi.mocked(enableBacktestShare);
const revokeMock = vi.mocked(revokeBacktestShare);

const DEFINITIONS = {
  strategy: {
    origin: "custom",
    publication: "opt_in",
    short:
      "Buys when RSI 14D is below 27. Closes the position when Price is below EMA 50D.",
  },
  list: {
    origin: "built_in",
    builtInName: "S&P 500 — Historical PIT",
    publication: "always",
    short:
      "Uses historical S&P 500 membership to determine eligible securities at each point in time.",
  },
} as const;

const NOT_SHARED = {
  shared: false,
  url: null,
  sharedAt: null,
  publishDescriptions: false,
  definitions: DEFINITIONS,
} as const;
const URL_ONE =
  "https://factorsage.example/share/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const URL_TWO =
  "https://factorsage.example/share/BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const SHARED_ONE = {
  shared: true,
  url: URL_ONE,
  sharedAt: "2026-10-22T10:00:00.000Z",
  publishDescriptions: false,
  definitions: DEFINITIONS,
} as const;

async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function openDialog() {
  render(<BacktestShareControl runId="run-1" />);
  await settle();
  fireEvent.click(screen.getByTestId("backtest-share"));
  return screen.getByTestId("backtest-share-dialog");
}

beforeEach(() => {
  fetchShareMock.mockReset();
  enableMock.mockReset();
  revokeMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("BacktestShareControl", () => {
  it("explains what a link publishes and what stays private before creating one", async () => {
    fetchShareMock.mockResolvedValue(NOT_SHARED);
    const dialog = await openDialog();

    expect(
      screen.getByTestId("backtest-share").getAttribute("data-shared"),
    ).toBe("false");
    expect(dialog.textContent).toContain("read-only report");
    expect(screen.getByTestId("backtest-share-privacy").textContent).toContain(
      "The securities in your list, the individual trades and the trade log always stay private.",
    );
    expect(screen.queryByTestId("backtest-share-url")).toBeNull();
    expect(enableMock).not.toHaveBeenCalled();
  });

  it("creates the link on request and offers it to copy", async () => {
    fetchShareMock.mockResolvedValue(NOT_SHARED);
    enableMock.mockResolvedValue(SHARED_ONE);
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await openDialog();

    fireEvent.click(screen.getByTestId("backtest-share-enable"));
    await settle();

    expect(enableMock).toHaveBeenCalledWith("run-1", {
      publishDescriptions: false,
    });
    const field = screen.getByTestId("backtest-share-url") as HTMLInputElement;
    expect(field.value).toBe(URL_ONE);
    expect(field.readOnly).toBe(true);
    expect(screen.getByTestId("backtest-share-open").getAttribute("href")).toBe(
      URL_ONE,
    );
    expect(
      screen.getByTestId("backtest-share").getAttribute("data-shared"),
    ).toBe("true");

    fireEvent.click(screen.getByTestId("backtest-share-copy"));
    await settle();
    expect(writeText).toHaveBeenCalledWith(URL_ONE);
    expect(screen.getByTestId("backtest-share-copy").textContent).toBe(
      "Copied",
    );
  });

  it("shows the existing link for a run that is already shared", async () => {
    fetchShareMock.mockResolvedValue(SHARED_ONE);
    await openDialog();
    expect(screen.getByTestId("backtest-share").textContent).toBe("Shared");
    expect(
      (screen.getByTestId("backtest-share-url") as HTMLInputElement).value,
    ).toBe(URL_ONE);
    expect(screen.queryByTestId("backtest-share-enable")).toBeNull();
  });

  it("stops sharing only after a second, explicit confirmation", async () => {
    fetchShareMock.mockResolvedValue(SHARED_ONE);
    revokeMock.mockResolvedValue(undefined);
    await openDialog();

    fireEvent.click(screen.getByTestId("backtest-share-revoke"));
    expect(revokeMock).not.toHaveBeenCalled();
    expect(
      screen.getByTestId("backtest-share-revoke-confirm").textContent,
    ).toContain("stops working immediately");

    fireEvent.click(screen.getByTestId("backtest-share-revoke-confirm-button"));
    await settle();
    expect(revokeMock).toHaveBeenCalledWith("run-1");
    expect(screen.queryByTestId("backtest-share-url")).toBeNull();
    expect(screen.getByTestId("backtest-share-enable")).toBeTruthy();
    expect(screen.getByTestId("backtest-share").textContent).toBe("Share");
  });

  it("shows the fresh link the server mints after sharing again", async () => {
    fetchShareMock.mockResolvedValue(SHARED_ONE);
    revokeMock.mockResolvedValue(undefined);
    enableMock.mockResolvedValue({ ...SHARED_ONE, url: URL_TWO });
    await openDialog();

    fireEvent.click(screen.getByTestId("backtest-share-revoke"));
    fireEvent.click(screen.getByTestId("backtest-share-revoke-confirm-button"));
    await settle();
    fireEvent.click(screen.getByTestId("backtest-share-enable"));
    await settle();

    expect(
      (screen.getByTestId("backtest-share-url") as HTMLInputElement).value,
    ).toBe(URL_TWO);
  });

  it("keeps the link and says so when stopping fails", async () => {
    fetchShareMock.mockResolvedValue(SHARED_ONE);
    revokeMock.mockRejectedValue(new Error("offline"));
    await openDialog();

    fireEvent.click(screen.getByTestId("backtest-share-revoke"));
    fireEvent.click(screen.getByTestId("backtest-share-revoke-confirm-button"));
    await settle();

    expect(screen.getByRole("alert").textContent).toContain("did not work");
    expect(screen.getByTestId("backtest-share").textContent).toBe("Shared");
  });

  it("says where the strategy and list come from, and what each publishes", async () => {
    fetchShareMock.mockResolvedValue(NOT_SHARED);
    await openDialog();
    const strategy = screen.getByTestId("backtest-share-definition-strategy");
    expect(strategy.getAttribute("data-origin")).toBe("custom");
    expect(strategy.textContent).toContain("Custom");
    expect(strategy.textContent).toContain("Buys when RSI 14D is below 27.");
    expect(strategy.textContent).toContain(
      "stays private unless you publish it",
    );
    const list = screen.getByTestId("backtest-share-definition-list");
    expect(list.textContent).toContain("Built-in · Official FactorSage List");
    expect(list.textContent).toContain(
      "is public: it is official FactorSage content",
    );
  });

  it("publishes the owner's descriptions only when the owner ticks the option, with a warning", async () => {
    fetchShareMock.mockResolvedValue(NOT_SHARED);
    enableMock.mockResolvedValue({ ...SHARED_ONE, publishDescriptions: true });
    await openDialog();

    const option = screen.getByTestId(
      "backtest-share-publish",
    ) as HTMLInputElement;
    expect(option.checked).toBe(false);
    expect(
      screen.getByTestId("backtest-share-publish-warning").textContent,
    ).toContain(
      "reveals your strategy's conditions — the metrics, operators and thresholds it uses",
    );
    fireEvent.click(option);
    expect(enableMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("backtest-share-enable"));
    await settle();
    expect(enableMock).toHaveBeenCalledWith("run-1", {
      publishDescriptions: true,
    });
    expect(
      (screen.getByTestId("backtest-share-publish") as HTMLInputElement)
        .checked,
    ).toBe(true);
  });

  it("changes an existing link's choice at once", async () => {
    fetchShareMock.mockResolvedValue(SHARED_ONE);
    enableMock.mockResolvedValue({ ...SHARED_ONE, publishDescriptions: true });
    await openDialog();
    fireEvent.click(screen.getByTestId("backtest-share-publish"));
    await settle();
    expect(enableMock).toHaveBeenCalledWith("run-1", {
      publishDescriptions: true,
    });
    expect(
      screen.getByTestId("backtest-share-definition-strategy").textContent,
    ).toContain("is published on the report");
  });

  it("offers no choice when every description is official", async () => {
    fetchShareMock.mockResolvedValue({
      ...NOT_SHARED,
      definitions: {
        strategy: {
          ...DEFINITIONS.list,
          short: "Buys when Price is above SMA 200D.",
        },
        list: DEFINITIONS.list,
      },
    });
    await openDialog();
    expect(screen.queryByTestId("backtest-share-publish")).toBeNull();
  });

  it("lets the owner of a link from before definitions were recorded opt in", async () => {
    fetchShareMock.mockResolvedValue({
      shared: true,
      url: URL_ONE,
      sharedAt: SHARED_ONE.sharedAt,
      publishDescriptions: false,
    });
    await openDialog();
    expect(screen.queryByTestId("backtest-share-definitions")).toBeNull();
    expect(screen.getByTestId("backtest-share-publish")).toBeTruthy();
  });
});
