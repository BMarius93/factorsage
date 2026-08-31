import { PageContainer } from "../../../components/layout/PageContainer";
import styles from "./RoutePlaceholder.module.css";

type RoutePlaceholderProps = {
  readonly title: string;
  readonly description: string;
};

/**
 * Temporary route content so the shell's primary destinations resolve. Each
 * page is replaced by its real feature slice.
 */
export function RoutePlaceholder({
  title,
  description,
}: RoutePlaceholderProps) {
  return (
    <PageContainer>
      <p className={styles.label}>FactorSage</p>
      <h1 className={styles.title}>{title}</h1>
      <p className={styles.description}>{description}</p>
    </PageContainer>
  );
}
