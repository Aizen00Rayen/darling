import type { Faq as FaqEntry } from '@/data/products';

export function Faq({ faqs }: { faqs: FaqEntry[] }) {
  return (
    <section className="details">
      {faqs.map((faq) => (
        <details key={faq.title}>
          <summary>
            {faq.title} <span>+</span>
          </summary>
          <p>{faq.body}</p>
        </details>
      ))}
    </section>
  );
}
