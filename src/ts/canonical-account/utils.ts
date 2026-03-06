/**
 * CanonicalAccount Deployment Utilities
 *
 * Provides utilities for deploying and interacting with the
 * CanonicalAccount contract, which restricts execution to a single
 * validated token transfer with fee sponsorship handled internally
 * by the contract itself (no signature verification).
 */

import type { AuthWitnessProvider } from "@aztec/aztec.js/account";
import { AccountManager } from "@aztec/aztec.js/wallet";
import type { Wallet } from "@aztec/aztec.js/wallet";
import { DefaultAccountContract } from "@aztec/accounts/defaults";
import { Fr } from "@aztec/aztec.js/fields";
import type { FeePaymentMethod } from "@aztec/aztec.js/fee";
import { AuthWitness } from "@aztec/stdlib/auth-witness";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import type { CompleteAddress } from "@aztec/stdlib/contract";
import type { ContractArtifact } from "@aztec/stdlib/abi";
import { ExecutionPayload } from "@aztec/stdlib/tx";
import {
  CanonicalAccountContract as CanonicalAccountContractType,
  CanonicalAccountContractArtifact,
} from "../../artifacts/CanonicalAccount.js";

class NoopAuthWitnessProvider implements AuthWitnessProvider {
  async createAuthWit(messageHash: Fr): Promise<AuthWitness> {
    return new AuthWitness(messageHash, []);
  }
}

/**
 * AccountContract implementation for the CanonicalAccount.
 * Uses DefaultAccountContract base class which provides the standard
 * entrypoint (AppPayload) integration via DefaultAccountEntrypoint.
 */
export class CanonicalAccountAccountContract extends DefaultAccountContract {
  constructor(
    private tokenAddress: AztecAddress,
    private sponsoredFpcAddress: AztecAddress,
  ) {
    super();
  }

  async getContractArtifact(): Promise<ContractArtifact> {
    return CanonicalAccountContractArtifact;
  }

  async getInitializationFunctionAndArgs() {
    return {
      constructorName: "constructor",
      constructorArgs: [this.tokenAddress, this.sponsoredFpcAddress],
    };
  }

  getAuthWitnessProvider(_address: CompleteAddress): AuthWitnessProvider {
    return new NoopAuthWitnessProvider();
  }
}

/**
 * Fee payment method for the CanonicalAccount's self-handled fee model.
 *
 * Sets `feePayer` to the SponsoredFPC address (so the SDK picks
 * `AccountFeePaymentMethodOptions.EXTERNAL = 0`) but adds NO calls
 * to the execution payload -- the Noir contract calls
 * `sponsor_unconditionally()` internally.
 */
export class SelfHandledFeePaymentMethod implements FeePaymentMethod {
  constructor(private fpcAddress: AztecAddress) {}

  getAsset(): Promise<AztecAddress> {
    throw new Error("Not applicable for self-handled fees");
  }

  getFeePayer() {
    return Promise.resolve(this.fpcAddress);
  }

  async getExecutionPayload(): Promise<ExecutionPayload> {
    return new ExecutionPayload([], [], [], [], this.fpcAddress);
  }

  getGasSettings() {
    return undefined;
  }
}

export interface DeployCanonicalAccountResult {
  manager: AccountManager;
  contract: CanonicalAccountContractType;
  address: AztecAddress;
}

/**
 * Deploys the CanonicalAccount contract as a proper account,
 * registered with the PXE so the SDK can route transactions through it.
 *
 * Must be deployed from a real deployer address (not AztecAddress.ZERO)
 * because AztecAddress.ZERO triggers self-deployment which calls the
 * account's entrypoint -- incompatible with the tx-root assertion.
 *
 * After deployment, monkey-patches `wallet.getAccountFromAddress` so that
 * `send({from: canonicalAccountAddress})` works without modifying the SDK.
 */
export async function deployCanonicalAccount(
  wallet: Wallet,
  tokenAddress: AztecAddress,
  sponsoredFpcAddress: AztecAddress,
  deployer: AztecAddress,
  options?: {
    secretKey?: Fr;
    salt?: Fr;
    fee?: { paymentMethod: any };
  },
): Promise<DeployCanonicalAccountResult> {
  const secretKey = options?.secretKey ?? Fr.random();
  const salt = options?.salt ?? Fr.random();

  const accountContract = new CanonicalAccountAccountContract(
    tokenAddress,
    sponsoredFpcAddress,
  );
  const manager = await AccountManager.create(
    wallet,
    secretKey,
    accountContract,
    salt,
  );

  const instance = manager.getInstance();
  const artifact = await accountContract.getContractArtifact();
  await wallet.registerContract(instance, artifact, manager.getSecretKey());

  const deployMethod = await manager.getDeployMethod();
  await deployMethod.send({
    from: deployer,
    skipClassPublication: false,
    skipInstancePublication: false,
    fee: options?.fee,
  });

  // Patch the wallet so it can resolve this account for send({from: ...}).
  // EmbeddedWallet.getAccountFromAddress uses walletDB which only knows
  // built-in account types. We intercept calls for our address.
  const account = await manager.getAccount();
  const original = (wallet as any).getAccountFromAddress.bind(wallet);
  (wallet as any).getAccountFromAddress = async (address: AztecAddress) => {
    if (address.equals(manager.address)) {
      return account;
    }
    return original(address);
  };

  const contract = CanonicalAccountContractType.at(manager.address, wallet);

  return { manager, contract, address: manager.address };
}

export { CanonicalAccountContractType as CanonicalAccountContract };
export { CanonicalAccountContractArtifact };
