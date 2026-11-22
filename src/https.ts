// Self-signed HTTPS certificate for testing on phones over Wi-Fi.
// Browsers only allow the live camera on https (or localhost), so the app also listens on https.
// The phone shows a one-time "not private" warning because the certificate is self-made. TEST ONLY.
// TODO(SECURITY): a real deployment needs a real domain and a real certificate (e.g. Let's Encrypt).
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

export function ensureCert(ips: string[]): { key: Buffer; cert: Buffer } | null {
  const dir = path.join(__dirname, '..', '.cert');
  const keyFile = path.join(dir, 'key.pem');
  const certFile = path.join(dir, 'cert.pem');
  const forFile = path.join(dir, 'made-for.txt');
  const want = ips.join(',');

  try {
    const upToDate = fs.existsSync(keyFile) && fs.existsSync(certFile) && fs.readFileSync(forFile, 'utf8') === want;
    if (!upToDate) {
      fs.mkdirSync(dir, { recursive: true });
      const cnf = path.join(dir, 'openssl.cnf');
      fs.writeFileSync(
        cnf,
        [
          '[req]', 'distinguished_name=dn', 'x509_extensions=v3', 'prompt=no',
          '[dn]', 'CN=Desk TEST BUILD',
          '[v3]',
          `subjectAltName=DNS:localhost,IP:127.0.0.1${ips.map((ip) => `,IP:${ip}`).join('')}`,
          'basicConstraints=CA:FALSE', 'keyUsage=digitalSignature,keyEncipherment', 'extendedKeyUsage=serverAuth',
        ].join('\n'),
      );
      execFileSync(
        'openssl',
        ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '365', '-keyout', keyFile, '-out', certFile, '-config', cnf],
        { stdio: 'ignore' },
      );
      fs.writeFileSync(forFile, want);
    }
    return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
  } catch (e: any) {
    console.error('Could not create the https certificate (is openssl installed?):', e.message);
    return null;
  }
}
