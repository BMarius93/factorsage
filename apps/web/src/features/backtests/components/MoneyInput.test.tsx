import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { groupThousands, MoneyInput, rawAmount } from "./MoneyInput";

describe("MoneyInput (BT-7)", () => {
  it("groups thousands for display and keeps anything else as typed", () => {
    expect(groupThousands("10000")).toBe("10,000");
    expect(groupThousands("1234567.5")).toBe("1,234,567.5");
    expect(groupThousands("999")).toBe("999");
    expect(groupThousands("")).toBe("");
    expect(groupThousands("12a")).toBe("12a");
  });

  it("strips grouping, the dollar sign and spaces from what is typed or pasted", () => {
    expect(rawAmount("$12,500.50 ")).toBe("12500.50");
    expect(rawAmount("abc")).toBe("abc");
  });

  function Harness({ initial = "10000" }: { readonly initial?: string }) {
    const [value, setValue] = useState(initial);
    held = value;
    return (
      <>
        <label htmlFor="capital">Initial capital</label>
        <MoneyInput
          id="capital"
          testId="capital"
          value={value}
          invalid={false}
          onValueChange={setValue}
        />
        <button type="button">elsewhere</button>
      </>
    );
  }
  let held = "";

  it("groups the amount while it is read and typed, and holds the raw value", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByLabelText("Initial capital") as HTMLInputElement;
    expect(input.value).toBe("10,000");

    await user.click(input);
    expect(input.value).toBe("10,000");
    await user.clear(input);
    await user.paste("$25,000");
    expect(held).toBe("25000");
    expect(input.value).toBe("25,000");
    await user.type(input, "0");
    expect(held).toBe("250000");
    expect(input.value).toBe("250,000");

    await user.click(screen.getByRole("button", { name: "elsewhere" }));
    expect(input.value).toBe("250,000");
    expect(held).toBe("250000");
  });

  // Found by the E2E suite: Playwright's fill selects the field and focuses it, then types. An
  // earlier version switched to raw digits on focus, which replaced the value under that selection,
  // and "25000" was appended to the old amount ("1000025000"). Tab selects the same way.
  it.each([
    ["selected and then focused, as Playwright's fill does", "before"],
    ["focused and then selected, as Tab does", "after"],
  ] as const)(
    "replaces the whole amount when it is %s",
    async (_label, when) => {
      const user = userEvent.setup();
      render(<Harness />);
      const input = screen.getByTestId("capital") as HTMLInputElement;

      act(() => {
        if (when === "before") {
          input.select();
        }
        input.focus();
        if (when === "after") {
          input.select();
        }
      });
      await user.keyboard("25000");
      expect(held).toBe("25000");
      expect(input.value).toBe("25,000");
    },
  );

  it("keeps the caret on the same digit as the grouping moves", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByTestId("capital") as HTMLInputElement;
    // "10,0|00": three digits in. Typing 5 makes it "100,5|00".
    await user.click(input);
    input.setSelectionRange(4, 4);
    await user.keyboard("5");
    expect(held).toBe("100500");
    expect(input.value).toBe("100,500");
    expect(input.selectionStart).toBe(5);
  });

  it("steps over a separator on Backspace rather than storing a change", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByTestId("capital") as HTMLInputElement;
    await user.click(input);
    // "10,|000": deleting the comma changes no digit.
    input.setSelectionRange(3, 3);
    await user.keyboard("{Backspace}");
    expect(held).toBe("10000");
    expect(input.value).toBe("10,000");
    expect(input.selectionStart).toBe(2);
  });
});
