import { ProductPage } from '@/components/ProductPage';
import { RefCapture } from '@/components/RefCapture';
import { defaultProduct } from '@/data/products';

export default function Home() {
  return (
    <>
      <RefCapture />
      <ProductPage product={defaultProduct} />
    </>
  );
}
