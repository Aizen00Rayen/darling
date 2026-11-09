'use client';

import { useEffect, useRef } from 'react';

type Props = { desktop: string; mobile: string; poster: string; label: string };

/** Loads its source only once 20 % visible, plays muted in a loop, pauses off-screen. */
export function ProductVideo({ desktop, mobile, poster, label }: Props) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && entry.intersectionRatio >= 0.2) {
          if (!video.getAttribute('src')) {
            video.src = window.matchMedia('(max-width: 700px)').matches ? mobile : desktop;
            video.load();
          }
          video.muted = true;
          video.play().catch(() => {});
        } else {
          video.pause();
        }
      },
      { threshold: [0, 0.2] },
    );
    observer.observe(video);
    return () => observer.disconnect();
  }, [desktop, mobile]);

  return (
    <video
      ref={ref}
      className="product-video"
      muted
      loop
      playsInline
      disablePictureInPicture
      disableRemotePlayback
      preload="none"
      poster={poster}
      aria-label={label}
    />
  );
}
