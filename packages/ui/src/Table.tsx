import type { ReactNode } from 'react';
import { cx } from './cx';

export type TableColumn<T> = {
  key: string;
  header: string;
  render(row: T): ReactNode;
  /** Hide the column (via CSS, the markup stays) below 700 px (`sm`) or below 1000 px (`md`). */
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
      <table className="dl-table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={cx(hide(c))}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {columns.map((c) => (
                <td key={c.key} data-label={c.header} className={cx(hide(c))}>
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
