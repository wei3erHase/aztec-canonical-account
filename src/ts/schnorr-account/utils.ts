/**
 * SchnorrAccount Deployment Utilities
 *
 * This module provides utilities for deploying and interacting with the
 * SchnorrAccount contract, which uses an initializer to store the signing
 * public key in SinglePrivateImmutable storage.
 *
 * ## Usage
 *
 * ```typescript
 * const { contract, secretKey } = await deploySchnorrAccount(wallet, { secretKey: Fr.random() });
 * ```
 */

import { Fr } from "@aztec/aztec.js/fields";
import type { Wallet } from "@aztec/aztec.js/wallet";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import { deriveSigningKey } from "@aztec/stdlib/keys";
import type { EmbeddedWallet } from "@aztec/wallets/embedded";
import {
  SchnorrAccountContract,
  SchnorrAccountContractArtifact,
} from "../../artifacts/SchnorrAccount.js";

/**
 * Signing public key type (Grumpkin curve point coordinates)
 */
export interface SigningPublicKey {
  x: Fr;
  y: Fr;
}

/**
 * Result of deploying a SchnorrAccount
 */
export interface DeploySchnorrAccountResult {
  contract: SchnorrAccountContract;
  secretKey: Fr;
  signingPublicKey: SigningPublicKey;
}

/**
 * Deploys the standard SchnorrAccount contract.
 *
 * This uses the proper account deployment pattern via EmbeddedWallet.createSchnorrAccount():
 * 1. Creates account with secret key (uses the default SchnorrAccountContract)
 * 2. Registers the account with PXE (including public keys for encryption)
 * 3. Deploys and initializes the contract
 * 4. Note delivery is handled automatically via MessageDelivery.CONSTRAINED_ONCHAIN
 *
 *
 * @param wallet - The wallet to deploy with (must be an EmbeddedWallet)
 * @param options - Optional deployment options
 * @returns The deployed contract instance and keys
 */
export async function deploySchnorrAccount(
  wallet: Wallet,
  options?: {
    secretKey?: Fr;
    salt?: Fr;
    fee?: { paymentMethod: any };
  },
): Promise<DeploySchnorrAccountResult> {
  // Generate or use provided secret key
  const secretKey = options?.secretKey ?? Fr.random();
  const salt = options?.salt ?? Fr.random();

  // Derive signing key from secret to get the public key
  const signingKey = deriveSigningKey(secretKey);
  const signingPublicKey: SigningPublicKey = {
    x: new Fr(signingKey.lo),
    y: new Fr(signingKey.hi),
  };

  // Use EmbeddedWallet.createSchnorrAccount which uses the SDK's SchnorrAccountContract
  // This handles all the auth witness provider setup properly
  const embeddedWallet = wallet as unknown as EmbeddedWallet;
  const accountManager = await embeddedWallet.createSchnorrAccount(
    secretKey,
    salt,
  );

  // Deploy the account contract using AztecAddress.ZERO as sender
  // (the deploy protocol handles the first-tx exception for account contracts)
  const deployMethod = await accountManager.getDeployMethod();
  await deployMethod.send({ from: AztecAddress.ZERO, fee: options?.fee });

  // Get the deployed contract instance using our local artifact
  // Note: This will have the same address but uses our local artifact
  const contract = SchnorrAccountContract.at(accountManager.address, wallet);

  return {
    contract,
    secretKey,
    signingPublicKey,
  };
}

/**
 * Export the artifact for direct access if needed
 */
export { SchnorrAccountContract, SchnorrAccountContractArtifact };

/**
 * Deploys the SchnorrAccount contract directly with explicit signing key.
 *
 * @param wallet - The wallet to deploy with
 * @param deployer - The account address that pays fees and sends the deploy transaction
 * @param options - Optional deployment options
 * @returns The deployed contract instance and keys
 */
export async function deployLocalSchnorrAccount(
  wallet: Wallet,
  deployer: AztecAddress,
  options?: {
    signingPublicKey?: SigningPublicKey;
    salt?: Fr;
  },
): Promise<{
  contract: SchnorrAccountContract;
  signingPublicKey: SigningPublicKey;
}> {
  // Use provided signing key or generate arbitrary values
  const signingPublicKey = options?.signingPublicKey ?? {
    x: new Fr(0xdeadbeefcafebabe1234n),
    y: new Fr(0xfeedface5678abcdn),
  };

  // Deploy our local SchnorrAccount contract with the initializer
  const contract = await SchnorrAccountContract.deploy(
    wallet,
    signingPublicKey.x,
    signingPublicKey.y,
  ).send({ from: deployer });

  return {
    contract,
    signingPublicKey,
  };
}
