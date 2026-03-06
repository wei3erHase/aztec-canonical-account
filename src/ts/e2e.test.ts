/**
 * E2E Test: Canonical Account Contract
 *
 * Validates that the CanonicalAccount contract can receive private tokens
 * and transfer them using a restricted entrypoint that validates the
 * call target, function selector, and fee handling.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import { Fr } from "@aztec/aztec.js/fields";
import type { SponsoredFeePaymentMethod } from "@aztec/aztec.js/fee/testing";
import { setupTestSuite } from "./utils.js";
import {
  deployCanonicalAccount,
  SelfHandledFeePaymentMethod,
  type DeployCanonicalAccountResult,
} from "./canonical-account/utils.js";
import { TokenContract } from "@aztec/noir-contracts.js/Token";

describe("Canonical Account", () => {
  let cleanup: () => Promise<void>;
  let wallet: Awaited<ReturnType<typeof setupTestSuite>>["wallet"];
  let deployerAddress: AztecAddress;
  let token: TokenContract;
  let sponsoredPaymentMethod: SponsoredFeePaymentMethod;
  let sponsoredFpcAddress: AztecAddress;
  let selfHandledFee: SelfHandledFeePaymentMethod;

  const MINT_AMOUNT = 1000n;

  beforeAll(async () => {
    let accounts: AztecAddress[];
    ({ cleanup, wallet, accounts, sponsoredPaymentMethod } =
      await setupTestSuite());
    deployerAddress = accounts[0];
    sponsoredFpcAddress = await sponsoredPaymentMethod.getFeePayer();
    selfHandledFee = new SelfHandledFeePaymentMethod(sponsoredFpcAddress);

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
      sponsoredFpcAddress,
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
      sponsoredFpcAddress,
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
        fee: { paymentMethod: selfHandledFee },
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
        sponsoredFpcAddress,
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
            fee: { paymentMethod: selfHandledFee },
          }),
      ).rejects.toThrow(/call must use transfer_in_private selector/);
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
            fee: { paymentMethod: selfHandledFee },
          }),
      ).rejects.toThrow(/call must target the expected token/);
    });
  });
});
