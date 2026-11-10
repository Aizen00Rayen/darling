import type { ReactNode } from 'react';
import { cx } from './cx';

export type TableColumn<T> = {
  key: string;
  header: string;
  render(row: T): ReactNode;
  /**
   * Hide the column (via CSS, the markup stays): `sm` below 700 px, `md` below 1000 px. In card mode
   * (< 700 px) both are hidden, since 700 px is below 1000 px too.
   */
  hideBelow?: 'sm' | 'md';
};

export type TableProps<T> = {
  columns: TableColumn<T>[];
  rows: T[];
  empty: ReactNode;
};

/**
 * Below 700 px each row becomes a card; every cell carries its column header in `data-label`,
 * which the stylesheet shows as a label.
 */
export function Table<T>({ columns, rows, empty }: TableProps<T>) {
  if (rows.length === 0) return <div className="dl-table-empty glass">{empty}</div>;

  const hide = (c: TableColumn<T>) => (c.hideBelow ? `dl-hide-${c.hideBelow}` : undefined);

  return (
    <div className="dl-table-wrap glass">
      <table className="dl-table" role="table">
        <thead role="rowgroup">
          <tr role="row">
            {columns.map((c) => (
              <th key={c.key} scope="col" role="columnheader" className={cx(hide(c))}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody role="rowgroup">
          {rows.map((row, i) => (
            <tr key={i} role="row">
              {columns.map((c) => (
                <td key={c.key} role="cell" data-label={c.header} className={cx(hide(c))}>
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
