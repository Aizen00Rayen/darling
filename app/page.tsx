import { ProductPage } from '@/components/ProductPage';
import { defaultProduct } from '@/data/products';

export default function Home() {
  return <ProductPage product={defaultProduct} />;
}
