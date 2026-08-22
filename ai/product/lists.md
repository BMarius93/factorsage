# Lists

A list is a static user-owned or built-in collection of symbols.

Each symbol has independent BUY-window semantics.

```ts
type BuyWindow =
  | { mode: "FULL" }
  | { mode: "CUSTOM"; startDate: string; endDate: string };
```

The buy window restricts when a new BUY may occur for that symbol during a backtest.

Do not reintroduce index membership PIT through list semantics.
