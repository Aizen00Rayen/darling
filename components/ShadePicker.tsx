import type { CSSProperties } from 'react';
import type { Shade } from '@/data/products';

type Props = { shades: Shade[]; index: number; onChange: (index: number) => void };

export function ShadePicker({ shades, index, onChange }: Props) {
  return (
    <>
      <div className="shade-heading">
        <span>CHOISISSEZ VOTRE TEINTE</span>
        <strong>{shades[index].code}</strong>
      </div>
      <div className="swatches" role="group" aria-label="Choisir une teinte">
        {shades.map((shade, i) => (
          <button
            key={shade.code}
            type="button"
            className={`swatch${i === index ? ' active' : ''}`}
            style={{ '--shade': shade.color } as CSSProperties}
            aria-label={`Teinte ${shade.code.replace('*', '')}`}
            aria-pressed={i === index}
            onClick={() => onChange(i)}
          >
            <i />
            <span>{shade.code}</span>
          </button>
        ))}
      </div>
    </>
  );
}
