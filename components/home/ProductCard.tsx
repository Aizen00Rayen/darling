import Image from 'next/image';
import Link from 'next/link';
import type { Product } from '@/data/products';

function stockLabel(stock: number | undefined): { text: string; tone: 'out' | 'low' } | null {
  if (stock === undefined) return null;
  if (stock <= 0) return { text: 'Épuisé', tone: 'out' };
  if (stock <= 10) return { text: 'Dernières pièces', tone: 'low' };
  return null;
}

export function ProductCard({ product }: { product: Product }) {
  const cover = product.slides[0];
  const badge = stockLabel(product.stock);
  return (
    <Link className="card" href={`/produit/${product.slug}`}>
      <div className="card-media">
        {cover && <Image src={cover.src} alt={cover.alt || product.name} fill sizes="(max-width:700px) 80vw, 320px" />}
        {badge && <span className={`card-badge card-badge-${badge.tone}`}>{badge.text}</span>}
      </div>
      <div className="card-body">
        <h3>{product.name}</h3>
        <p>{product.tagline.join(' ')}</p>
        <div className="card-foot">
          <strong>
            {product.price.toLocaleString('fr-FR').replace(/ | /g, ' ')} <small>DA</small>
          </strong>
          {product.shades.length > 0 && (
            <span className="card-shades" aria-label={`${product.shades.length} teintes`}>
              {product.shades.map((s) => (
                <i key={s.code} style={{ background: s.color }} />
              ))}
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}
