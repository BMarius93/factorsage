import { redirect } from "next/navigation";

/**
 * `/stocks` has no page of its own (UI-051): a stock is reached through search, a list, a monitor
 * or a backtest, and each of those lands on `/stocks/[symbol]`. A visit here goes to the Dashboard,
 * whose topbar search is where finding a stock starts. A research landing is a separate product
 * decision, not a placeholder to keep.
 */
export default function StocksIndex() {
  redirect("/dashboard");
}
