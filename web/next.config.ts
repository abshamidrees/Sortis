import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // The relayer SDK ships WASM and reaches for node built-ins that do not exist
  // in the browser bundle. Neither is needed client-side.
  webpack(cfg) {
    cfg.resolve.fallback = { ...cfg.resolve.fallback, fs: false, path: false, crypto: false };

    // RainbowKit pulls in wagmi's full connector set, which includes Base
    // Account, which depends on @coinbase/cdp-sdk, which optionally imports the
    // x402 payment protocol. x402 is not published as a resolvable dependency
    // here and Sortis never touches that code path -- the only wallets this
    // app needs are injected and WalletConnect. Stub the optional imports
    // rather than installing a payments SDK to satisfy a connector we do not
    // offer.
    cfg.resolve.alias = {
      ...cfg.resolve.alias,
      "@x402/core/client": false,
      "@x402/evm": false,
      "@x402/evm/exact/client": false,
      "@x402/evm/upto/client": false,
      "@x402/svm/exact/client": false,
    };

    return cfg;
  },
  async headers() {
    return [
      {
        // The relayer SDK instantiates WASM and wants cross-origin isolation.
        //
        // COOP is same-origin-allow-popups, not same-origin. Wallet SDKs open
        // a popup and then talk to it through window.opener, and same-origin
        // severs that handle, which is the console error that shipped on every
        // page load. The allow-popups variant keeps the isolation the WASM
        // wants and leaves the opener intact.
        //
        // COEP is credentialless rather than require-corp, because
        // require-corp blocks any cross-origin subresource that does not opt
        // in, and the Google Fonts stylesheet does not.
        source: "/:path*",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
          { key: "Cross-Origin-Embedder-Policy", value: "credentialless" },
        ],
      },
    ];
  },
};

export default config;
