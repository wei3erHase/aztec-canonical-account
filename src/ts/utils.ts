import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { rmSync } from "fs";
import { join } from "path";

import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { getContractInstanceFromInstantiationParams } from "@aztec/aztec.js/contracts";
import { Fr } from "@aztec/aztec.js/fields";
import { SponsoredFeePaymentMethod } from "@aztec/aztec.js/fee/testing";
import { SponsoredFPCContract } from "@aztec/noir-contracts.js/SponsoredFPC";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { registerInitialLocalNetworkAccountsInWallet } from "@aztec/wallets/testing";

const { NODE_URL = "http://localhost:8080" } = process.env;

/**
 * Setup the node, wallet and accounts for tests.
 * @param proverEnabled - optional - Whether to enable the prover.
 * @returns The wallet, accounts and a cleanup function. Call `cleanup()` in afterAll to teardown.
 */
export async function setupTestSuite(proverEnabled: boolean = false) {
  const node = createAztecNodeClient(NODE_URL);
  await waitForNode(node);

  const dataDirectory = join(
    tmpdir(),
    `canonical-wallet-${randomBytes(8).toString("hex")}`,
  );

  const wallet = await EmbeddedWallet.create(node, {
    pxeConfig: { dataDirectory, proverEnabled },
  });

  const accounts: AztecAddress[] =
    await registerInitialLocalNetworkAccountsInWallet(wallet);

  const cleanup = async () => {
    await wallet.stop();
    try {
      rmSync(dataDirectory, { recursive: true, force: true });
    } catch {}
  };

  // Register the canonical SponsoredFPC for fee sponsorship.
  // Needed for txs sent by accounts without fee juice (e.g., custom accounts,
  // AztecAddress.ZERO account deployments). NOT needed for publications from
  // the pre-funded deployer.
  const sponsoredFPCAddress = await registerSponsoredFPC(wallet);
  const sponsoredPaymentMethod = new SponsoredFeePaymentMethod(
    sponsoredFPCAddress,
  );

  return {
    node,
    wallet,
    accounts,
    sponsoredPaymentMethod,
    cleanup,
  };
}

/**
 * Register the canonical SponsoredFPC contract and return its address.
 * The SponsoredFPC is deployed at a well-known address using salt = 0.
 */
async function registerSponsoredFPC(
  wallet: EmbeddedWallet,
): Promise<AztecAddress> {
  const instance = await getContractInstanceFromInstantiationParams(
    SponsoredFPCContract.artifact,
    { salt: new Fr(0n) },
  );
  await wallet.registerContract(instance, SponsoredFPCContract.artifact);
  return instance.address;
}
