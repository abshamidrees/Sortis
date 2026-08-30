/**
 * DNS and timeout hardening, installed before anything else loads.
 *
 *     NODE_OPTIONS="--require ./scripts/net-preload.js" npx hardhat run ...
 *
 * WHY A PRELOAD RATHER THAN AN IMPORT. `import hre from "hardhat"` is hoisted,
 * so it and the fhevm plugin construct their HTTP clients before any statement
 * in the script body runs. Calling this from inside the script set the global
 * dispatcher too late to affect them, which is why the first attempt at this
 * fix changed nothing and the seeding kept dying at the same point.
 *
 * WHAT IT FIXES. The machine's configured DNS server intermittently refuses
 * queries: `dns.resolve4` returns ECONNREFUSED against it while the relayer
 * answers a GET in under 300ms. `dns.setServers` alone does not help, because
 * it redirects only the `dns.resolve*` family; `dns.lookup`, which is what
 * undici and therefore fetch actually call, goes through getaddrinfo and stays
 * on the system resolver. So this replaces the lookup itself.
 *
 * The connect timeout is also raised off undici's 10s default, which is tight
 * for eu-west-1 over a slow link.
 */

const dns = require("dns");
const { Agent, setGlobalDispatcher } = require("undici");

dns.setServers(["1.1.1.1", "8.8.8.8", "9.9.9.9"]);

function lookup(hostname, options, callback) {
  dns.resolve4(hostname, (error, addresses) => {
    if (!error && addresses && addresses.length) {
      if (options && options.all) {
        callback(null, addresses.map((address) => ({ address, family: 4 })));
      } else {
        callback(null, addresses[0], 4);
      }
      return;
    }
    // Cloudflare could not answer either. Fall back rather than fail: a
    // hostname only present in a local hosts file still has to resolve.
    dns.lookup(hostname, options, callback);
  });
}

setGlobalDispatcher(
  new Agent({
    connect: { timeout: 60_000, lookup },
    headersTimeout: 180_000,
    bodyTimeout: 180_000,
  }),
);
