import Link from 'next/link';
import { pageCount } from '@/lib/portal/query';

type Props = {
  page: number;
  total: number;
  pageSize: number;
  /** Builds the href of another page, keeping the current filters. */
  hrefFor: (page: number) => string;
};

export function Pager({ page, total, pageSize, hrefFor }: Props) {
  const pages = pageCount(total, pageSize);
  return (
    <nav className="p-pager" aria-label="Pagination">
      <span>
        Page {page} sur {pages} — {total} résultat{total > 1 ? 's' : ''}
      </span>
      <div className="p-pager__links">
        {page > 1 ? (
          <Link className="dl-btn dl-btn--ghost" href={hrefFor(page - 1)} rel="prev">
            Précédent
          </Link>
        ) : null}
        {page < pages ? (
          <Link className="dl-btn dl-btn--ghost" href={hrefFor(page + 1)} rel="next">
            Suivant
          </Link>
        ) : null}
      </div>
    </nav>
  );
}
