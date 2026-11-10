import Image from 'next/image';
import '@darling/ui/tokens.css';
import '@darling/ui/portal.css';
import './auth.css';

export default function AuthLayout({ children }: LayoutProps<'/'>) {
  return (
    <div className="dl-portal">
      <main className="auth-shell">
        <div className="auth-brand" aria-label="Darling">
          <Image src="/assets/darling-logo.png" alt="" width={43} height={43} priority />
          <span aria-hidden="true">DARLING</span>
        </div>
        <div className="glass auth-card">{children}</div>
      </main>
    </div>
  );
}
