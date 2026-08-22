import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "IntrinsicValue",
  description: "Stock valuation, backtesting, and monitoring"
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
