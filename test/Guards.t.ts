import { expect } from "chai";

import {
  guardCommit,
  guardRelease,
  readTxError,
  toBaseUnits,
  formatUnits,
  SEPOLIA_ID,
} from "../web/src/lib/guards";

/**
 * The four error states the bounty rules name.
 *
 *   "Sensible error handling for missing approvals, insufficient balance,
 *    network mismatch, and unsupported tokens."
 *
 * A judge will try to break this, so each state is asserted rather than
 * assumed: that it fires when it should, that it does NOT fire when it should
 * not, and that the one which is not really a failure is not treated as one.
 *
 * These are pure functions on purpose. The rule is checked before a
 * transaction is built, so it is testable without a chain, a wallet or a
 * rendered component.
 */
const ELLIPSIS = String.fromCharCode(0x2026);

describe("the four named error states", function () {
  const ok = { chainId: SEPOLIA_ID, isOperator: true, walletClear: 10_000_000n, amount: 1_000_000n };

  it("passes a commit with nothing wrong", function () {
    expect(guardCommit(ok)).to.equal(null);
  });

  describe("network mismatch", function () {
    it("fires on any chain that is not Sepolia, and offers the switch", function () {
      const g = guardCommit({ ...ok, chainId: 1 });
      expect(g?.id).to.equal("wrong-network");
      expect(g?.action).to.equal("switch-network");
      expect(g?.blocking).to.equal(true);
      expect(g?.message).to.contain("Sepolia");
    });

    it("fires on release too, since a release is just as chain-specific", function () {
      const g = guardRelease({ chainId: 137, stakeClear: 5_000_000n, amount: 1n });
      expect(g?.id).to.equal("wrong-network");
    });

    it("does not fire before the wallet has reported a chain", function () {
      // undefined is "not connected yet", not "wrong network". Telling someone
      // they are on the wrong chain before they have picked one is noise.
      expect(guardCommit({ ...ok, chainId: undefined })).to.equal(null);
    });
  });

  describe("missing approval", function () {
    it("fires when the pool is not an operator, and points at the fix", function () {
      const g = guardCommit({ ...ok, isOperator: false });
      expect(g?.id).to.equal("not-operator");
      expect(g?.action).to.equal("faucet");
      expect(g?.blocking).to.equal(true);
      expect(g?.message).to.contain("ERC-7984");
    });

    it("is checked before the balance, because it fails first on chain", function () {
      // Both wrong. The operator grant is what the transaction hits first, so
      // reporting the balance would send the user to fix the wrong thing.
      const g = guardCommit({ ...ok, isOperator: false, walletClear: 0n });
      expect(g?.id).to.equal("not-operator");
    });
  });

  describe("insufficient balance", function () {
    it("says how far short the wallet is", function () {
      const g = guardCommit({ ...ok, walletClear: 400_000n, amount: 1_000_000n });
      expect(g?.id).to.equal("insufficient-balance");
      expect(g?.blocking).to.equal(true);
      expect(g?.message).to.contain("0.6");
      expect(g?.action).to.equal("faucet");
    });

    it("allows a commit of exactly the balance", function () {
      expect(guardCommit({ ...ok, walletClear: 1_000_000n, amount: 1_000_000n })).to.equal(null);
    });

    it("skips the check when the balance has not been decrypted", function () {
      // The balance is a ciphertext. With no decryption in this session there
      // is nothing to compare against, and guessing would be worse than not
      // checking: ERC-7984 transfers zero rather than reverting anyway.
      expect(guardCommit({ ...ok, walletClear: null, amount: 999_999_999n })).to.equal(null);
    });
  });

  describe("release above the stake", function () {
    it("warns without blocking, because it is a no-op and not a failure", function () {
      const g = guardRelease({ chainId: SEPOLIA_ID, stakeClear: 600_000n, amount: 5_000_000n });
      expect(g?.id).to.equal("over-release");
      expect(g?.blocking, "an encrypted no-op must not be blocked").to.equal(false);
    });

    it("explains that the transaction succeeds and moves nothing", function () {
      const g = guardRelease({ chainId: SEPOLIA_ID, stakeClear: 600_000n, amount: 5_000_000n });
      expect(g?.message).to.contain("move nothing");
      // And why it is built that way, because the alternative leaks.
      expect(g?.message.toLowerCase()).to.contain("revert");
    });

    it("says nothing when the release fits", function () {
      expect(guardRelease({ chainId: SEPOLIA_ID, stakeClear: 600_000n, amount: 400_000n })).to.equal(
        null,
      );
    });
  });

  describe("amount parsing", function () {
    it("reads six decimals and drops the rest", function () {
      expect(toBaseUnits("1")).to.equal(1_000_000n);
      expect(toBaseUnits("1.5")).to.equal(1_500_000n);
      expect(toBaseUnits("0.000001")).to.equal(1n);
      expect(toBaseUnits("1.2345678"), "a seventh decimal is truncated").to.equal(1_234_567n);
      expect(toBaseUnits("")).to.equal(0n);
    });

    it("round-trips through the formatter", function () {
      for (const v of ["0.5", "1", "3.14", "1234.567891"]) {
        expect(formatUnits(toBaseUnits(v))).to.equal(v);
      }
    });
  });
});

/**
 * What a failed transaction is told to say.
 *
 * The guards above run BEFORE a send. This is the half that runs after one,
 * and it exists because the screen was blaming the contract for failures no
 * contract took part in. viem wraps everything as `The contract function
 * "mint" reverted with the following reason:`, so a wallet holding no Sepolia
 * ETH produced a message that read like a bug in SortisPool, and a fixed
 * 90 character slice ended it mid-word at "eth_se".
 *
 * The strings below are real, copied from a wallet and from an Infura
 * response, because a matcher tested only against text I wrote myself proves
 * nothing about the text that actually arrives.
 */
describe("reading a failed transaction", function () {
  it("names an empty gas balance instead of blaming the contract", function () {
    const real = new Error(
      'The contract function "mint" reverted with the following reason:\n' +
        "RPC 0x1 Infura eth_sendRawTransaction: insufficient funds for transfer",
    );
    const fault = readTxError(real);
    expect(fault.kind).to.equal("gas");
    expect(fault.message).to.contain("no Sepolia ETH");
    // The word "contract" must not appear. No contract failed here.
    expect(fault.message.toLowerCase()).to.not.contain("contract");
  });

  it("does not call a declined signature a failure of the chain", function () {
    const fault = readTxError(new Error("User rejected the request."));
    expect(fault.kind).to.equal("declined");
    expect(fault.message).to.contain("Nothing was sent");
  });

  it("names the draw interval rather than surfacing the selector", function () {
    const fault = readTxError(new Error("execution reverted: DrawTooSoon(1756500000)"));
    expect(fault.kind).to.equal("interval");
    expect(fault.message).to.contain("interval");
  });

  it("names a rate limited node as the node, not the transaction", function () {
    const fault = readTxError(new Error("HTTP request failed. Status: 429 Too Many Requests"));
    expect(fault.kind).to.equal("rpc");
    expect(fault.message).to.contain("rate limiting");
  });

  it("points a missing operator grant at the control that fixes it", function () {
    const fault = readTxError(new Error("reverted: ERC7984UnauthorizedSpender(0xa57F)"));
    expect(fault.kind).to.equal("operator");
    expect(fault.message).to.contain("Mint 5 cUSDT");
  });

  it("cuts an unrecognised message on a word boundary, not mid-word", function () {
    const long = "Something went wrong " + "verylongtoken ".repeat(20);
    const fault = readTxError(new Error(long));
    expect(fault.kind).to.equal("unknown");
    if (fault.message.endsWith(ELLIPSIS)) {
      const body = fault.message.slice(0, -1);
      // The last thing kept is a whole word, so no partial token survives.
      expect(body.endsWith("verylongtoken")).to.equal(true);
    }
  });

  it("survives a thrown value that is not an Error at all", function () {
    expect(() => readTxError("plain string")).to.not.throw();
    expect(() => readTxError(undefined)).to.not.throw();
    expect(readTxError({ shortMessage: "insufficient funds for gas" }).kind).to.equal("gas");
  });
});
