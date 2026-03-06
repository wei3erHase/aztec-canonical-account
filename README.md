# Canonical Account Contract

A restricted Aztec account contract that validates calls against a specific token address and function selector before forwarding execution. No signature verification is performed — every transaction to this account is accepted.

This is a stepping stone toward the [FPC cold-start solution](https://gist.github.com/wei3erHase/6890bf7480f70daf5a1c4899a1d44c28), validating that the Aztec JS SDK and Noir can interact seamlessly when the account contract enforces specific call patterns instead of dispatching arbitrary calls.

## How It Works

In a standard Aztec transaction, the flow is:

```
kernel ──► account_contract.entrypoint(AppPayload)     [msg_sender = None]
                └──► token.transfer(args)               [msg_sender = account]
```

The account contract receives an `AppPayload` from the SDK, verifies a cryptographic signature, then dispatches arbitrary calls listed in the payload.

The **canonical account** replaces signature verification with call validation:

```
kernel ──► canonical_account.entrypoint(AppPayload)    [msg_sender = None]
                └──► token.transfer_in_private(args)    [msg_sender = canonical_account]
```

It asserts:
1. **Transaction root** — `maybe_msg_sender().is_none()`, proving this is the kernel's initial call (not batched from another account).
2. **Target validation** — at least one call in the payload targets the expected token contract (stored in `PublicImmutable` storage during construction).
3. **Selector validation** — calls to the expected token must use the `transfer_in_private` function selector.

Other calls in the payload (e.g., `sponsor_unconditionally` for fee sponsorship) are allowed through. The payload is then forwarded via `app_payload.execute_calls()`.

## Project Structure

```
src/
├── nr/
│   └── canonical_account_contract/    # Noir contract
│       └── src/
│           └── main.nr
└── ts/
    ├── canonical-account/             # TypeScript deployment utilities
    │   ├── index.ts
    │   └── utils.ts
    ├── e2e.test.ts                    # End-to-end tests
    └── utils.ts                       # Test infrastructure (wallet, node, fees)
```

## Usage

### TypeScript

```bash
yarn add @defi-wonderland/canonical-wallet
```

```typescript
import { deployCanonicalAccount } from "@defi-wonderland/canonical-wallet/canonical-account";

const { contract, address } = await deployCanonicalAccount(
  wallet,
  tokenAddress,
  deployerAddress,
  { fee: { paymentMethod: sponsoredPaymentMethod } },
);

// Send a transfer through the canonical account
await token.methods
  .transfer_in_private(address, recipient, amount, Fr.ZERO)
  .send({ from: address, fee: { paymentMethod: sponsoredPaymentMethod } });
```

### Noir dependency

```toml
[dependencies]
canonical_account_contract = { path = "../path/to/canonical-wallet/src/nr/canonical_account_contract" }
```

## Development

### Prerequisites

- [Aztec CLI](https://docs.aztec.network/) (`v4.0.0-devnet.2-patch.1`)
- [Noir](https://noir-lang.org/) (`>=1.0.0`)
- Node.js (`>=22.0.0`)
- Yarn (`>=1.22.0`)
- A running Aztec sandbox or devnet node at `http://localhost:8080`

### Setup

```bash
yarn install
```

### Build

```bash
yarn ccc   # Clean, compile Noir contracts, and generate TypeScript artifacts
```

### Test

```bash
yarn test       # Noir + TypeScript
yarn test:nr    # Noir only
yarn test:js    # TypeScript E2E only
```

## Difficulties & Lessons Learned

### `AppPayload.function_calls` is crate-private

The `function_calls` field on `AppPayload` (defined in `aztec-nr`) is not `pub`, making it inaccessible from external crates. We work around this by serializing the entire payload via the `Serialize` trait and reading individual `FunctionCall` fields at known offsets (6 fields per call: `args_hash`, `function_selector`, `target_address`, `is_public`, `hide_msg_sender`, `is_static`).

### `SharedImmutable` does not exist in this Aztec version

The plan called for `SharedImmutable<AztecAddress>` storage. This state variable does not exist in `v4.0.0-devnet.2-patch.1`. We use `PublicImmutable<AztecAddress>` instead, which supports initialization from a public constructor and reading from private context via historical public storage proofs.

### Function selector string format

`FunctionSelector::from_signature(...)` in Noir and `FunctionSelector.fromSignature(...)` in the SDK both hash the signature string with `poseidon2_hash_bytes`. The string format encodes structs as parenthesized tuples of their fields — `AztecAddress` becomes `(Field)`, not `AztecAddress`. So the correct signature is:

```
transfer_in_private((Field),(Field),u128,Field)
```

This was discovered by reading the SDK's `FunctionSignatureDecoder` which recursively encodes struct fields as `(field_type1,field_type2,...)`.

### Deployment cannot use `AztecAddress.ZERO`

`DeployAccountMethod.send({from: AztecAddress.ZERO})` triggers a self-deployment flow that wraps the fee payment through the account's own entrypoint via `AccountEntrypointMetaPaymentMethod`. This calls our entrypoint before the contract is deployed as the tx root, which fails the `maybe_msg_sender().is_none()` check (the multicall entrypoint is the actual root). Deploying from a real deployer address avoids this.

### Contract class must be published on-chain for public constructors

The default `DeployAccountMethod` options set `skipClassPublication: true` and `skipInstancePublication: true`. Since our constructor is `#[external("public")]`, the AVM needs the contract class bytecode on-chain. Setting both to `false` fixes the public-execution revert.

### `set_sender_for_tags` must be called before note delivery

When the token contract emits private logs (note delivery during `transfer_in_private`), it calls `get_sender_for_tags()` to determine the tag sender. Standard account contracts set this via the `AccountActions` helper. Since we bypass `AccountActions`, we must call `set_sender_for_tags(self.context.this_address())` explicitly before `execute_calls`.

### Wallet integration requires monkey-patching

`EmbeddedWallet.getAccountFromAddress` uses `walletDB` which only knows built-in account types (`'schnorr'`, `'ecdsasecp256k1'`, `'ecdsasecp256r1'`). Custom account contracts cannot be stored in `walletDB`. We patch `getAccountFromAddress` at runtime to return our `AccountManager`-derived `Account` for the canonical address, enabling standard `send({from: canonicalAddress})` syntax.

### Fee calls are merged into the AppPayload

The `SponsoredFeePaymentMethod.getExecutionPayload()` returns a call to `sponsor_unconditionally()`. The SDK's `ContractFunctionInteraction.request()` merges this fee call into the same `ExecutionPayload` as the app call, with fee calls **first**. Both end up in the `AppPayload.function_calls` array. The canonical account must therefore scan all calls for the expected transfer rather than assuming it is at index 0.

## Connection to FPC Cold-Start

This contract validates the core primitive used in the [cold-start FPC flow](https://gist.github.com/wei3erHase/6890bf7480f70daf5a1c4899a1d44c28): using `maybe_msg_sender().is_none()` as a kernel-level proof that a function is the transaction root. The cold-start FPC will use the same mechanism to ensure that `cold_start_entrypoint` is the sole initial call, preventing batching of arbitrary revertible logic after `end_setup()`.

Key concepts validated here that carry forward:

- **`maybe_msg_sender().is_none()`** reliably enforces tx-root status from Noir
- **`AppPayload` + `DefaultAccountEntrypoint`** can be used by custom account contracts without `AccountActions`
- **The SDK can route transactions** through custom accounts via `send({from: customAccount})` with the wallet patch
- **`PublicImmutable` storage** can be initialized in a public constructor and read from private entrypoints

## License

MIT
