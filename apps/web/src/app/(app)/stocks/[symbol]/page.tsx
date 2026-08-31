import { RoutePlaceholder } from "../../_placeholder/RoutePlaceholder";

type StockDetailsPageProps = {
  readonly params: Promise<{ readonly symbol: string }>;
};

/**
 * Destination for every global stock-search selection. Stock Details itself is a later slice, so
 * this stays a thin placeholder; the route exists now so search navigation resolves.
 */
export default async function StockDetailsPage({
  params,
}: StockDetailsPageProps) {
  const { symbol } = await params;

  return (
    <RoutePlaceholder
      title={decodeURIComponent(symbol).toUpperCase()}
      description="Stock Details arrives in its own slice. Search navigation already resolves here."
    />
  );
}
