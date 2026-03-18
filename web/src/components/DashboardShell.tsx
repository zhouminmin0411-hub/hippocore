import type { ReactNode } from 'react';

interface DashboardShellProps {
  header: ReactNode;
  summary: ReactNode;
  filters: ReactNode;
  timeline: ReactNode;
}

export function DashboardShell({ header, summary, filters, timeline }: DashboardShellProps) {
  return (
    <div className="app-shell">
      <div className="app-shell__inner">
        {header}
        {summary}
        <section className="app-shell__main">
          {filters}
          {timeline}
        </section>
      </div>
    </div>
  );
}
