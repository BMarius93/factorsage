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

const NOT_SHARED = { shared: false, url: null, sharedAt: null } as const;
const URL_ONE =
  "https://factorsage.example/share/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const URL_TWO =
  "https://factorsage.example/share/BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const SHARED_ONE = {
  shared: true,
  url: URL_ONE,
  sharedAt: "2026-10-22T10:00:00.000Z",
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
      "rules, the stock list and its securities, and the trade log stay private",
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

    expect(enableMock).toHaveBeenCalledWith("run-1");
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
});
