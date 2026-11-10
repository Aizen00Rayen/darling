/** Groups a base32 secret by four characters for manual entry: `JBSW Y3DP EHPK 3PXP`. */
export function groupSecret(secret: string): string {
  const clean = secret.replace(/[\s=]/g, '').toUpperCase();
  return clean.match(/.{1,4}/g)?.join(' ') ?? '';
}
