import Image from 'next/image';
import type { Slide } from '@/data/products';
import { wrapIndex } from '@/lib/order-form-state';
import { LeftIcon, RightIcon } from './icons';

/** Slides from this index on are shade renders, shown uncropped on a plain background. */
const FIRST_UNCROPPED_SLIDE = 3;

type Props = { name: string; slides: Slide[]; index: number; onChange: (index: number) => void };

const pad = (n: number) => String(n).padStart(2, '0');

export function Gallery({ name, slides, index, onChange }: Props) {
  const slide = slides[index];
  const go = (next: number) => onChange(wrapIndex(next, slides.length));

  return (
    <div className="gallery">
      <div className={`hero-photo${index >= FIRST_UNCROPPED_SLIDE ? ' shade-photo' : ''}`}>
        <Image
          src={slide.src}
          alt={slide.alt}
          width={1350}
          height={1350}
          sizes="(max-width: 700px) 100vw, 520px"
          loading="eager"
          fetchPriority="high"
        />
        <div className="photo-label glass">
          THE GLOSS
          <br />
          YOU’LL FALL FOR.
        </div>
        <div className="gallery-bottom">
          <span className="glass photo-counter">
            {pad(index + 1)} / {pad(slides.length)}
          </span>
          <div className="arrows">
            <button type="button" className="glass" aria-label="Photo précédente" onClick={() => go(index - 1)}>
              <LeftIcon />
            </button>
            <button type="button" className="glass" aria-label="Photo suivante" onClick={() => go(index + 1)}>
              <RightIcon />
            </button>
          </div>
        </div>
      </div>
      <div className="thumbs" aria-label={`Photos ${name}`}>
        {slides.map((thumb, i) => (
          <button
            key={thumb.src}
            type="button"
            className={`thumb${i === index ? ' active' : ''}`}
            aria-label={thumb.thumbLabel}
            aria-pressed={i === index}
            onClick={() => onChange(i)}
          >
            <Image src={thumb.src} alt="" width={80} height={80} />
          </button>
        ))}
        <span>
          UN SWIPE.
          <br />
          ET LE CRUSH.
        </span>
      </div>
    </div>
  );
}
