import dns from "dns";
import { Agent, setGlobalDispatcher } from "undici";

/**
 * Make outbound HTTP survive a flaky system resolver.
 *
 * Symptom: every long script died with `ConnectTimeoutError` from undici,
 * usually on the first relayer call, and re-running got one more transaction
 * through before dying the same way. Eight consecutive attempts at seeding
 * managed four stakes between them.
 *
 * Cause: the machine's configured DNS server intermittently refuses queries.
 * `dns.resolve4` returns ECONNREFUSED against it while the relayer and the RPC
 * are both perfectly reachable, which is why the failure looked like a remote
 * outage and was not one.
 *
 * `dns.setServers` alone does not fix this. It only redirects the `dns.resolve*`
 * family; `dns.lookup`, which is what undici and therefore fetch actually call,
 * goes through getaddrinfo and stays on the system resolver. So this installs a
 * custom `lookup` that resolves through Cloudflare and falls back to the system
 * path only if that fails.
 *
 * The connect timeout is also raised. Ten seconds is the undici default and is
 * tight for eu-west-1 over a slow link.
 */
export function installResilientDns(): void {
  dns.setServers(["1.1.1.1", "8.8.8.8", "9.9.9.9"]);

  const lookup = ((
    hostname: string,
    options: dns.LookupOneOptions,
    callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
  ) => {
    dns.resolve4(hostname, (error, addresses) => {
      if (!error && addresses?.length) {
        callback(null, addresses[0], 4);
        return;
      }
      // Cloudflare could not answer either. Fall back rather than fail: a
      // hostname only present in a local hosts file still has to resolve.
      dns.lookup(hostname, options, callback);
    });
  }) as typeof dns.lookup;

  setGlobalDispatcher(
    new Agent({
      connect: { timeout: 60_000, lookup },
      headersTimeout: 120_000,
      bodyTimeout: 120_000,
    }),
  );
}
