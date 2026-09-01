import type { Metadata } from "next";
import { StockDetails } from "../../../../features/stocks/details/components/StockDetails";
import { normalizeStockSymbol } from "../../../../features/stocks/details/utils/route-symbol";

type StockDetailsPageProps = {
  readonly params: Promise<{ readonly symbol: string }>;
};

export async function generateMetadata({
  params,
}: StockDetailsPageProps): Promise<Metadata> {
  const { symbol } = await params;
  const normalized = normalizeStockSymbol(symbol);
  return { title: normalized === "" ? "Stocks" : `${normalized} · FactorSage` };
}

/**
 * Destination for every global stock-search selection and for direct visits like `/stocks/AAPL`.
 * The route stays a thin composition boundary: the symbol is normalized here and everything else
 * lives in the stock-details feature.
 */
export default async function StockDetailsPage({
  params,
}: StockDetailsPageProps) {
  const { symbol } = await params;
  return <StockDetails symbol={normalizeStockSymbol(symbol)} />;
}
