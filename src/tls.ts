import tls from 'node:tls';

// ---------------------------------------------------------------------------
// GOTCHA (confirmed live against gitlab.example.com, GitLab 18.11.7):
//
// The internal GitLab presents ONLY its leaf certificate, signed by the internal
// "AcmeRootCA". Node ships its own fixed root bundle and ignores the Windows
// certificate store entirely, so every request fails with
//
//     TypeError: fetch failed
//       cause: UNABLE_TO_VERIFY_LEAF_SIGNATURE
//
// which carries no HTTP status and reads like the host being unreachable. It is
// not - DNS resolves and the TLS handshake completes. Windows DOES trust that
// CA (it is in LocalMachine\Root), which is why a browser on the same machine
// opens the site without complaint.
//
// The fix is to UNION the machine's trust store into Node's default roots. This
// is strictly ADDITIVE: it can only make more chains verifiable, never fewer,
// and verification stays on. That is the whole point of doing it this way rather
// than NODE_TLS_REJECT_UNAUTHORIZED=0, which switches verification off for the
// entire process - including the Atlassian calls - and would happily accept an
// intercepted connection.
//
// It is done in-process rather than with the `--use-system-ca` flag or
// NODE_EXTRA_CA_CERTS because the daily run is launched by Task Scheduler: a
// flag that has to be threaded through the scheduled action is a flag that gets
// lost, and the failure it causes looks like a network outage.
// ---------------------------------------------------------------------------

export interface TrustResult {
  applied: boolean;
  added: number;
  reason?: string;
}

/** Adds the operating system's trust store to Node's default CAs.
 *
 *  Requires the tls.getCACertificates / tls.setDefaultCACertificates pair added
 *  in Node 22.15. On anything older this reports why it could not run rather
 *  than throwing, so a Jira-only collection (Atlassian Cloud chains to a public
 *  root and needs none of this) still succeeds. */
export function trustSystemCertificateAuthorities(): TrustResult {
  if (typeof tls.getCACertificates !== 'function' || typeof tls.setDefaultCACertificates !== 'function') {
    return {
      applied: false,
      added: 0,
      reason:
        'this Node build has no tls.setDefaultCACertificates (added in 22.15); ' +
        'run node with --use-system-ca, or point NODE_EXTRA_CA_CERTS at the internal CA',
    };
  }

  let defaults: string[];
  let system: string[];
  try {
    defaults = tls.getCACertificates('default');
    system = tls.getCACertificates('system');
  } catch (err) {
    return { applied: false, added: 0, reason: (err as Error).message };
  }

  const merged = mergeCertificates(defaults, system);
  const added = merged.length - defaults.length;
  if (added === 0) return { applied: true, added: 0 };

  tls.setDefaultCACertificates(merged);
  return { applied: true, added };
}

/** Union of two PEM lists, preserving the order of the first.
 *
 *  Deduped on the normalised PEM text because the same root reaches Node from
 *  the bundled list and from the OS store with different line endings - CRLF out
 *  of the Windows store, LF out of the bundle - and a naive union would then
 *  install ~140 duplicate roots on every run. */
export function mergeCertificates(defaults: readonly string[], system: readonly string[]): string[] {
  const key = (pem: string) => pem.replace(/\s+/g, '');
  const seen = new Set(defaults.map(key));
  const out = [...defaults];
  for (const cert of system) {
    if (seen.has(key(cert))) continue;
    seen.add(key(cert));
    out.push(cert);
  }
  return out;
}
