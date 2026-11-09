import { describe, expect, it } from 'vitest';
import { defaultProduct, getProduct, products } from './products';

describe('product data', () => {
  it('describes Wet Kiss', () => {
    expect(defaultProduct).toMatchObject({ slug: 'wet-kiss', name: 'Wet Kiss', price: 3000, maxQuantity: 20 });
    expect(products).toContain(defaultProduct);
  });

  it('has the four live shades', () => {
    expect(defaultProduct.shades.map((s) => s.code)).toEqual(['*01', '*02', '*03', '*04']);
    expect(defaultProduct.shades.map((s) => s.color)).toEqual(['#fdecdd', '#f79797', '#bc5938', '#ff0000']);
  });

  it('has eight gallery slides with shade renders from index 4', () => {
    expect(defaultProduct.slides).toHaveLength(8);
    expect(defaultProduct.slides[0].src).toBe('/assets/wet-kiss.jpg');
    expect(defaultProduct.slides[4].src).toBe('/assets/shade-01.png');
    expect(defaultProduct.slides[7].src).toBe('/assets/shade-04.png');
  });

  it('carries ingredients and three FAQ entries', () => {
    expect(defaultProduct.ingredients.startsWith('Diisostearyl Malate')).toBe(true);
    expect(defaultProduct.faqs).toHaveLength(3);
    expect(defaultProduct.faqs[0].body).toBe(defaultProduct.ingredients);
  });

  it('looks products up by slug', () => {
    expect(getProduct('wet-kiss')).toBe(defaultProduct);
    expect(getProduct('nope')).toBeUndefined();
  });
});
