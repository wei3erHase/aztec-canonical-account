/**
 * E2E Test: Schnorr Account Contract
 *
 * Validates that the SchnorrAccount contract can receive and transfer private tokens.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import { Fr } from "@aztec/aztec.js/fields";
import type { SponsoredFeePaymentMethod } from "@aztec/aztec.js/fee/testing";
import { setupTestSuite } from "./utils.js";
import { deploySchnorrAccount } from "./schnorr-account/utils.js";
import { TokenContract } from "@aztec/noir-contracts.js/Token";

describe("Schnorr Account", () => {
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

  it("should mint to private balance of schnorr account", async () => {
    const standardAccount = await deploySchnorrAccount(wallet, {
      secretKey: Fr.random(),
      fee: { paymentMethod: sponsoredPaymentMethod },
    });

    const initialBalance = await token.methods
      .balance_of_private(standardAccount.contract.address)
      .simulate({ from: standardAccount.contract.address });
    expect(initialBalance).toEqual(0n);

    await token.methods
      .mint_to_private(standardAccount.contract.address, MINT_AMOUNT)
      .send({ from: deployerAddress });

    const finalBalance = await token.methods
      .balance_of_private(standardAccount.contract.address)
      .simulate({ from: standardAccount.contract.address });

    expect(finalBalance).toEqual(MINT_AMOUNT);
  });

  it("should transfer private tokens from schnorr account", async () => {
    const standardAccount = await deploySchnorrAccount(wallet, {
      secretKey: Fr.random(),
      fee: { paymentMethod: sponsoredPaymentMethod },
    });

    await token.methods
      .mint_to_private(standardAccount.contract.address, MINT_AMOUNT)
      .send({ from: deployerAddress });

    const TRANSFER_AMOUNT = 100n;
    const deployerBalanceBefore = await token.methods
      .balance_of_private(deployerAddress)
      .simulate({ from: deployerAddress });

    // transfer_in_private: from account to deployer; account provides auth via entrypoint
    await token.methods
      .transfer_in_private(
        standardAccount.contract.address,
        deployerAddress,
        TRANSFER_AMOUNT,
        Fr.ZERO,
      )
      .send({
        from: standardAccount.contract.address,
        fee: { paymentMethod: sponsoredPaymentMethod },
      });

    const accountBalance = await token.methods
      .balance_of_private(standardAccount.contract.address)
      .simulate({ from: standardAccount.contract.address });
    expect(accountBalance).toEqual(MINT_AMOUNT - TRANSFER_AMOUNT);

    const deployerBalanceAfter = await token.methods
      .balance_of_private(deployerAddress)
      .simulate({ from: deployerAddress });
    expect(deployerBalanceAfter).toEqual(
      deployerBalanceBefore + TRANSFER_AMOUNT,
    );
  });
});
