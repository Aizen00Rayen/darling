import type { Metadata } from 'next';
import { ForgotForm } from '@/components/auth/ForgotForm';

export const metadata: Metadata = { title: 'Mot de passe oublié — Darling', robots: { index: false } };

export default function MotDePasseOubliePage() {
  return <ForgotForm />;
}
