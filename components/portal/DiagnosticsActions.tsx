'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Notice } from '@/ui';
import { api } from '@/lib/api/client';
import { backupFailureMessage, formatBytes, testMailFailureMessage } from '@/lib/portal/diagnostics';
import { ConfirmDialog } from './ConfirmDialog';

type Props = {
  hasBackup: boolean;
  smtpConfigured: boolean;
};

type Message = { tone: 'success' | 'error'; text: string };

/** Owner actions of the diagnostics page: back up now, download the newest backup (after a confirmation), send a test e-mail. */
export function DiagnosticsActions({ hasBackup, smtpConfigured }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<'backup' | 'mail' | null>(null);
  const [backupMessage, setBackupMessage] = useState<Message | null>(null);
  const [mailMessage, setMailMessage] = useState<Message | null>(null);
  const [confirming, setConfirming] = useState(false);

  async function backupNow() {
    if (busy) return;
    setBusy('backup');
    setBackupMessage(null);
    const result = await api<{ name: string; bytes: number }>('/api/backups', { method: 'POST' });
    setBusy(null);
    if (!result.ok) return setBackupMessage({ tone: 'error', text: backupFailureMessage(result.code) });
    setBackupMessage({ tone: 'success', text: `Sauvegarde créée : ${result.data.name} (${formatBytes(result.data.bytes)}).` });
    router.refresh();
  }

  function download() {
    setConfirming(false);
    // A plain navigation to the attachment URL: the browser saves the file and stays on the page.
    const link = document.createElement('a');
    link.href = '/api/backups/latest';
    link.download = '';
    document.body.append(link);
    link.click();
    link.remove();
    setBackupMessage({ tone: 'success', text: 'Téléchargement lancé. Rangez ce fichier en lieu sûr : il contient des données personnelles.' });
  }

  async function sendTestMail() {
    if (busy) return;
    setBusy('mail');
    setMailMessage(null);
    const result = await api<{ to: string }>('/api/diagnostics/test-mail', { method: 'POST' });
    setBusy(null);
    if (!result.ok) {
      return setMailMessage({ tone: 'error', text: testMailFailureMessage(result.code, result.reason) });
    }
    setMailMessage({ tone: 'success', text: `E-mail de test envoyé à ${result.data.to}. Vérifiez votre boîte de réception (et les indésirables).` });
    router.refresh();
  }

  return (
    <>
      <div className="p-actions">
        <Button onClick={backupNow} disabled={busy !== null}>
          {busy === 'backup' ? 'Sauvegarde en cours…' : 'Sauvegarder maintenant'}
        </Button>
        <Button variant="ghost" onClick={() => setConfirming(true)} disabled={!hasBackup}>
          Télécharger la dernière sauvegarde
        </Button>
      </div>
      {backupMessage ? <Notice tone={backupMessage.tone}>{backupMessage.text}</Notice> : null}

      <ConfirmDialog
        open={confirming}
        title="Télécharger la sauvegarde"
        confirmLabel="Télécharger"
        onConfirm={download}
        onCancel={() => setConfirming(false)}
      >
        <p>
          Cette sauvegarde contient <strong>toutes les données personnelles</strong> : noms, téléphones et adresses des clients, comptes et
          mots de passe chiffrés. Enregistrez-la dans un endroit sûr, ne l’envoyez à personne et supprimez-la quand vous n’en avez plus besoin.
        </p>
      </ConfirmDialog>

      <div className="p-actions">
        <Button onClick={sendTestMail} disabled={busy !== null || !smtpConfigured}>
          {busy === 'mail' ? 'Envoi…' : 'Envoyer un e-mail de test'}
        </Button>
      </div>
      {mailMessage ? <Notice tone={mailMessage.tone}>{mailMessage.text}</Notice> : null}
    </>
  );
}
