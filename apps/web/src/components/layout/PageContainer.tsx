import type { ReactNode } from "react";
import styles from "./PageContainer.module.css";

type PageContainerProps = {
  readonly children: ReactNode;
};

/** Responsive width/padding wrapper for route content inside the app shell. */
export function PageContainer({ children }: PageContainerProps) {
  return <div className={styles.container}>{children}</div>;
}
