"use client";

import type { BuiltInContentAdminResponse } from "@intrinsic/contracts";
import Link from "next/link";
import { useEffect, useState } from "react";
import {
  DataTable,
  type DataTableColumn,
} from "../../../components/ui/DataTable";
import { EmptyState } from "../../../components/ui/EmptyState";
import { SectionCard } from "../../../components/ui/SectionCard";
import { SkeletonList } from "../../../components/ui/Skeleton";
import { StatusBadge } from "../../../components/ui/StatusBadge";
import actionStyles from "../../../components/ui/actions.module.css";
import { lastScanLabel } from "../../monitors/utils/format";
import { fetchBuiltInContent } from "../api/admin-api";
import styles from "./BuiltInContentPanel.module.css";
import { formatDate } from "../../../lib/dates";

type Row = {
  readonly kind: "list" | "strategy" | "monitor";
  readonly id: string;
  readonly systemKey: string;
  readonly name: string;
  readonly detail: string;
  readonly status?: { readonly published: boolean; readonly running: boolean };
  readonly updated: string;
};

const HREF = {
  list: (id: string) => `/lists/${id}`,
  strategy: (id: string) => `/strategies/${id}`,
  monitor: (id: string) => `/monitors/${id}`,
};

const KIND_LABELS = {
  list: "List",
  strategy: "Strategy",
  monitor: "Monitor",
} as const;

function rowsOf(content: BuiltInContentAdminResponse): Row[] {
  const updated = (at: string, by?: string) =>
    `${formatDate(at)}${by ? ` · ${by}` : ""}`;
  return [
    ...content.monitors.map((monitor) => ({
      kind: "monitor" as const,
      id: monitor.id,
      systemKey: monitor.systemKey,
      name: monitor.name,
      detail: `${monitor.strategyName} over ${monitor.stockListName} · ${monitor.activeCount} active, ${monitor.pendingCount} waiting · checked ${lastScanLabel(monitor.lastScanAt)}`,
      status: {
        published: monitor.isPublished,
        running: monitor.isGloballyEnabled,
      },
      updated: updated(monitor.updatedAt, monitor.updatedByEmail),
    })),
    ...content.strategies.map((strategy) => ({
      kind: "strategy" as const,
      id: strategy.id,
      systemKey: strategy.systemKey,
      name: strategy.name,
      detail: `Version ${strategy.versionNumber}`,
      updated: updated(strategy.updatedAt, strategy.updatedByEmail),
    })),
    ...content.lists.map((list) => ({
      kind: "list" as const,
      id: list.id,
      systemKey: list.systemKey,
      name: list.name,
      detail: `${list.itemCount} stocks`,
      updated: updated(list.updatedAt, list.updatedByEmail),
    })),
  ];
}

const COLUMNS: readonly DataTableColumn<Row>[] = [
  {
    key: "name",
    header: "Built-in",
    cardRole: "identity",
    render: (row) => (
      <Link className={styles.name} href={HREF[row.kind](row.id)}>
        <span className={styles.kind}>{KIND_LABELS[row.kind]}</span>
        {row.name}
        <code className={styles.key}>{row.systemKey}</code>
      </Link>
    ),
  },
  {
    key: "status",
    header: "Status",
    cardRole: "status",
    render: (row) =>
      row.status ? (
        <span className={styles.badges}>
          <StatusBadge tone={row.status.published ? "positive" : "warning"}>
            {row.status.published ? "Published" : "Unpublished"}
          </StatusBadge>
          <StatusBadge tone={row.status.running ? "positive" : "pending"}>
            {row.status.running ? "Running" : "Paused"}
          </StatusBadge>
        </span>
      ) : null,
  },
  { key: "detail", header: "Details", render: (row) => row.detail },
  {
    key: "updated",
    header: "Last edited",
    nowrap: true,
    render: (row) => row.updated,
  },
  {
    key: "actions",
    header: "Actions",
    cardRole: "actions",
    align: "right",
    render: (row) => (
      <Link
        className={actionStyles.action}
        href={HREF[row.kind](row.id)}
        aria-label={`Edit ${row.name}`}
      >
        Edit
      </Link>
    ),
  },
];

/**
 * The administrator's entry point to built-in content. Editing happens on the ordinary list,
 * strategy and monitor pages, which open in their editable form for an administrator.
 */
export function BuiltInContentPanel() {
  const [content, setContent] = useState<BuiltInContentAdminResponse | null>(
    null,
  );
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetchBuiltInContent({ signal: controller.signal })
      .then(setContent)
      .catch(() => {
        if (!controller.signal.aborted) {
          setFailed(true);
        }
      });
    return () => controller.abort();
  }, []);

  return (
    <SectionCard
      id="built-in-content"
      title="Built-in content"
      caption="The lists, strategies and monitors every visitor sees. Changes apply to everyone; a normal deploy never overwrites them."
      flush={content !== null}
    >
      {failed ? (
        <EmptyState
          variant="error"
          title="Built-in content could not be loaded"
        />
      ) : content === null ? (
        <SkeletonList rows={4} />
      ) : (
        <DataTable
          label="Built-in content"
          testId="admin-built-ins"
          rowTestId="admin-built-in"
          columns={COLUMNS}
          rows={rowsOf(content)}
          getRowKey={(row) => `${row.kind}:${row.id}`}
          emptyState={
            <EmptyState
              variant="compact"
              title="No built-in content yet"
              body={<p>Run the built-in bootstrap to create it.</p>}
            />
          }
        />
      )}
    </SectionCard>
  );
}
