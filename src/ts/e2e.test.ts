/**
 * E2E Test: Canonical Account Contract
 *
 * Validates that the CanonicalAccount contract can receive private tokens
 * and transfer them using a restricted entrypoint that validates the
 * call target and function selector.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import { Fr } from "@aztec/aztec.js/fields";
import type { SponsoredFeePaymentMethod } from "@aztec/aztec.js/fee/testing";
import { setupTestSuite } from "./utils.js";
import {
  deployCanonicalAccount,
  type DeployCanonicalAccountResult,
} from "./canonical-account/utils.js";
import { TokenContract } from "@aztec/noir-contracts.js/Token";

describe("Canonical Account", () => {
  let cleanup: () => Promise<void>;
  let wallet: Awaited<ReturnType<typeof setupTestSuite>>["wallet"];
  let deployerAddress: AztecAddress;
  let token: TokenContract;
  let sponsoredPaymentMethod: SponsoredFeePaymentMethod;

  const MINT_AMOUNT = 1000n;

  beforeAll(async () => {
    ({
      cleanup,
      wallet,
      accounts: [deployerAddress],
      sponsoredPaymentMethod,
    } = await setupTestSuite());

    token = await TokenContract.deploy(
      wallet,
      deployerAddress, // admin
      "TestToken",
      "TST",
      18n,
    ).send({ from: deployerAddress });
  });

  afterAll(async () => {
    await cleanup();
  });

  it("should mint to private balance of canonical account", async () => {
    const { address: canonicalAddress } = await deployCanonicalAccount(
      wallet,
      token.address,
      deployerAddress,
      {
        secretKey: Fr.random(),
        fee: { paymentMethod: sponsoredPaymentMethod },
      },
    );

    const initialBalance = await token.methods
      .balance_of_private(canonicalAddress)
      .simulate({ from: canonicalAddress });
    expect(initialBalance).toEqual(0n);

    await token.methods
      .mint_to_private(canonicalAddress, MINT_AMOUNT)
      .send({ from: deployerAddress });

    const finalBalance = await token.methods
      .balance_of_private(canonicalAddress)
      .simulate({ from: canonicalAddress });

    expect(finalBalance).toEqual(MINT_AMOUNT);
  });

  it("should transfer private tokens from canonical account", async () => {
    const { address: canonicalAddress } = await deployCanonicalAccount(
      wallet,
      token.address,
      deployerAddress,
      {
        secretKey: Fr.random(),
        fee: { paymentMethod: sponsoredPaymentMethod },
      },
    );

    await token.methods
      .mint_to_private(canonicalAddress, MINT_AMOUNT)
      .send({ from: deployerAddress });

    const TRANSFER_AMOUNT = 100n;
    const deployerBalanceBefore = await token.methods
      .balance_of_private(deployerAddress)
      .simulate({ from: deployerAddress });

    await token.methods
      .transfer_in_private(
        canonicalAddress,
        deployerAddress,
        TRANSFER_AMOUNT,
        Fr.ZERO,
      )
      .send({
        from: canonicalAddress,
        fee: { paymentMethod: sponsoredPaymentMethod },
      });

    const accountBalance = await token.methods
      .balance_of_private(canonicalAddress)
      .simulate({ from: canonicalAddress });
    expect(accountBalance).toEqual(MINT_AMOUNT - TRANSFER_AMOUNT);

    const deployerBalanceAfter = await token.methods
      .balance_of_private(deployerAddress)
      .simulate({ from: deployerAddress });
    expect(deployerBalanceAfter).toEqual(
      deployerBalanceBefore + TRANSFER_AMOUNT,
    );
  });

  describe("negative cases", () => {
    let canonicalAddress: AztecAddress;
    let canonical: DeployCanonicalAccountResult;

    beforeAll(async () => {
      canonical = await deployCanonicalAccount(
        wallet,
        token.address,
        deployerAddress,
        {
          secretKey: Fr.random(),
          fee: { paymentMethod: sponsoredPaymentMethod },
        },
      );
      canonicalAddress = canonical.address;
    });

    it("should reject when not called as tx root", async () => {
      const dummyPayload = {
        function_calls: Array(5).fill({
          args_hash: Fr.ZERO,
          function_selector: 0,
          target_address: AztecAddress.ZERO,
          is_public: false,
          hide_msg_sender: false,
          is_static: false,
        }),
        tx_nonce: Fr.ZERO,
      };

      await expect(
        canonical.contract.methods.entrypoint(dummyPayload, 0, false).send({
          from: deployerAddress,
          fee: { paymentMethod: sponsoredPaymentMethod },
        }),
      ).rejects.toThrow(/must be tx entrypoint/);
    });

    it("should reject calling wrong function on the token", async () => {
      await expect(
        token.methods
          .transfer_to_public(canonicalAddress, deployerAddress, 1n, Fr.ZERO)
          .send({
            from: canonicalAddress,
            fee: { paymentMethod: sponsoredPaymentMethod },
          }),
      ).rejects.toThrow(/invalid selector for token call/);
    });

    it("should reject calling wrong token address", async () => {
      const otherToken = await TokenContract.deploy(
        wallet,
        deployerAddress,
        "OtherToken",
        "OTH",
        18n,
      ).send({ from: deployerAddress });

      await expect(
        otherToken.methods
          .transfer_in_private(canonicalAddress, deployerAddress, 1n, Fr.ZERO)
          .send({
            from: canonicalAddress,
            fee: { paymentMethod: sponsoredPaymentMethod },
          }),
      ).rejects.toThrow(/transfer call not found in payload/);
    });
  });
});
