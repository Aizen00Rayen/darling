import Image from 'next/image';

async function CopyrightYear() {
  'use cache';
  return <>{new Date().getFullYear()}</>;
}

export function Footer() {
  return (
    <footer>
      <a className="wordmark" href="#">
        DARLING
        <Image src="/assets/darling-logo.png" width={48} height={48} alt="" />
      </a>
      <span>Un dernier regard. Un nouveau crush.</span>
      <small>
        © <CopyrightYear /> Darling
      </small>
    </footer>
  );
}
