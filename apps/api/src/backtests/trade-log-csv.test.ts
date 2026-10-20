import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import {
  csvRecord,
  numberCell,
  TRADE_LOG_CSV_COLUMNS,
  textCell,
  tradeLogCsvHeader,
  tradeLogCsvRecord,
  tradeReasonText,
  UTF8_BOM,
  type TradeLogCsvTrade,
} from "./trade-log-csv";

/**
 * The CSV a reader opens in a spreadsheet. Three properties matter, and each is pinned here:
 *
 * - **RFC 4180**: a field is quoted exactly when it holds a comma, a quote, a CR or an LF, and a
 *   quote inside it is doubled — so a strategy sentence with a comma stays one column.
 * - **No formula injection**: a text cell a spreadsheet would evaluate is neutralised with `'`.
 * - **Raw numbers**: the stored decimals, unrounded and unformatted, and never touched by the
 *   formula guard — a loss is `-1058.78`, not `'-1058.78`.
 */
describe("csvRecord", () => {
  it("joins cells with commas and ends the record with CRLF", () => {
    expect(csvRecord([textCell("a"), textCell("b"), numberCell(3)])).toBe(
      "a,b,3\r\n",
    );
  });

  it("quotes exactly the fields RFC 4180 requires, doubling inner quotes", () => {
    expect(csvRecord([textCell("plain")])).toBe("plain\r\n");
    expect(csvRecord([textCell("a,b")])).toBe('"a,b"\r\n');
    expect(csvRecord([textCell('say "hi"')])).toBe('"say ""hi"""\r\n');
    expect(csvRecord([textCell("line\nbreak")])).toBe('"line\nbreak"\r\n');
    expect(csvRecord([textCell("carriage\rreturn")])).toBe(
      '"carriage\rreturn"\r\n',
    );
    // Spaces and non-ASCII text are not special.
    expect(csvRecord([textCell("Nestlé · CEO, CFO")])).toBe(
      '"Nestlé · CEO, CFO"\r\n',
    );
  });

  it("writes an absent value as an empty field", () => {
    expect(csvRecord([textCell(null), numberCell(null), textCell("x")])).toBe(
      ",,x\r\n",
    );
  });
});

describe("formula injection", () => {
  it("prefixes every text cell a spreadsheet would evaluate", () => {
    for (const hostile of ["=1+1", "+1", "-1", "@SUM(A1)", "\tx", "\rx"]) {
      const encoded = csvRecord([textCell(hostile)]);
      expect(encoded.startsWith("'") || encoded.startsWith(`"'`)).toBe(true);
    }
    expect(csvRecord([textCell("=1+1")])).toBe("'=1+1\r\n");
    expect(csvRecord([textCell("@SUM(A1)")])).toBe("'@SUM(A1)\r\n");
  });

  it("guards before quoting, so a guarded field that needs quotes is still one field", () => {
    expect(csvRecord([textCell('=HYPERLINK("http://x","y")')])).toBe(
      `"'=HYPERLINK(""http://x"",""y"")"\r\n`,
    );
    // A CR at the start is both a trigger and a reason to quote.
    expect(csvRecord([textCell("\r=1")])).toBe(`"'\r=1"\r\n`);
  });

  it("leaves text that merely contains a trigger alone", () => {
    expect(csvRecord([textCell("Price is above -5")])).toBe(
      "Price is above -5\r\n",
    );
    expect(csvRecord([textCell("A=B")])).toBe("A=B\r\n");
  });

  it("leaves numbers plain, negative ones included", () => {
    expect(csvRecord([numberCell(new Decimal("-1058.78"))])).toBe(
      "-1058.78\r\n",
    );
    expect(csvRecord([numberCell(-3)])).toBe("-3\r\n");
  });

  it("demotes anything that is not a plain decimal literal to guarded text", () => {
    // A value that only claims to be a number cannot use the exemption to carry a formula.
    const forged = { toFixed: () => "-1+cmd|' /C calc'!A0" };
    expect(csvRecord([numberCell(forged)])).toBe("'-1+cmd|' /C calc'!A0\r\n");
    expect(csvRecord([numberCell(Number.NaN)])).toBe("NaN\r\n");
    expect(numberCell(1e-7)).toEqual({ kind: "text", value: "1e-7" });
  });
});

describe("numberCell", () => {
  it("writes stored decimals exactly, in plain notation, unrounded", () => {
    expect(numberCell(new Decimal("212.7949123456"))).toEqual({
      kind: "number",
      value: "212.7949123456",
    });
    // Trailing zeros carry no information and are not written.
    expect(numberCell(new Decimal("226.48000000"))).toEqual({
      kind: "number",
      value: "226.48",
    });
    // Decimal.js would print this in exponent notation by default; a spreadsheet wants digits.
    expect(numberCell(new Decimal("0.00000001"))).toEqual({
      kind: "number",
      value: "0.00000001",
    });
    expect(numberCell(new Decimal("123456789012345678901234"))).toEqual({
      kind: "number",
      value: "123456789012345678901234",
    });
  });
});

describe("the trade log's columns", () => {
  const strategyBuy: TradeLogCsvTrade = {
    sequence: 7,
    date: "2024-03-01",
    symbol: "AAPL",
    name: "Apple Inc.",
    action: "BUY",
    source: "STRATEGY",
    levelPercentage: 25,
    shares: new Decimal("10.5"),
    price: new Decimal("180.25"),
    amount: new Decimal("1892.625"),
    realizedPnl: null,
    realizedPnlPercent: null,
    reason: {
      kind: "STRATEGY",
      conditions: ["SMA 50D is above SMA 200D", "RSI 14D is below 30"],
      trigger: "Price crosses above SMA 20D",
    },
  };

  it("starts with the header the documentation names", () => {
    expect(tradeLogCsvHeader()).toBe(
      "Sequence,Date,Symbol,Name,Action,Source,Level %,Shares,Price,Amount," +
        "Realized P/L,Realized P/L %,Reason\r\n",
    );
    expect(TRADE_LOG_CSV_COLUMNS).toHaveLength(13);
  });

  it("writes a strategy buy with raw values and its reason sentence", () => {
    expect(tradeLogCsvRecord(strategyBuy)).toBe(
      "7,2024-03-01,AAPL,Apple Inc.,BUY,STRATEGY,25,10.5,180.25,1892.625,,," +
        "SMA 50D is above SMA 200D and RSI 14D is below 30 · Triggered: Price crosses above SMA 20D\r\n",
    );
  });

  it("writes a liquidation as a sale whose source says the period ended", () => {
    expect(
      tradeLogCsvRecord({
        ...strategyBuy,
        sequence: 8,
        action: "SELL",
        source: "END_OF_BACKTEST",
        levelPercentage: null,
        realizedPnl: new Decimal("-12.5"),
        realizedPnlPercent: new Decimal("-0.66050198"),
        reason: { kind: "END_OF_BACKTEST" },
      }),
    ).toBe(
      "8,2024-03-01,AAPL,Apple Inc.,SELL,END_OF_BACKTEST,,10.5,180.25,1892.625,-12.5,-0.66050198,End of backtest\r\n",
    );
  });

  it("neutralises a hostile company name and quotes a name with a comma", () => {
    const record = tradeLogCsvRecord({
      ...strategyBuy,
      name: '=IMPORTXML("http://evil","//a")',
    });
    expect(record).toContain(`,"'=IMPORTXML(""http://evil"",""//a"")",`);
    expect(
      tradeLogCsvRecord({ ...strategyBuy, name: "Berkshire Hathaway, Inc." }),
    ).toContain(',"Berkshire Hathaway, Inc.",');
  });
});

describe("tradeReasonText", () => {
  it("draws the sentence the trade log draws", () => {
    expect(tradeReasonText(null)).toBe("");
    expect(tradeReasonText({ kind: "END_OF_BACKTEST" })).toBe(
      "End of backtest",
    );
    expect(
      tradeReasonText({
        kind: "STRATEGY",
        exitRule: 2,
        conditions: ["Price is below SMA 50D"],
      }),
    ).toBe("Exit rule 2: Price is below SMA 50D");
    // A Trigger alone has nothing to separate it from.
    expect(
      tradeReasonText({
        kind: "STRATEGY",
        conditions: [],
        trigger: "Price crosses above SMA 20D",
      }),
    ).toBe("Triggered: Price crosses above SMA 20D");
  });
});

describe("UTF8_BOM", () => {
  it("is the one code point U+FEFF", () => {
    expect(UTF8_BOM).toHaveLength(1);
    expect(UTF8_BOM.charCodeAt(0)).toBe(0xfeff);
  });
});
