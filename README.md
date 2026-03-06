# Canonical Account Contract

A restricted Aztec account contract that enforces a single `transfer_in_private` call to a known token, with fee sponsorship handled internally via the SponsoredFPC. No signature verification is performed -- every transaction to this account is accepted.

This is a stepping stone toward the [FPC cold-start solution](https://gist.github.com/wei3erHase/6890bf7480f70daf5a1c4899a1d44c28), validating that the Aztec JS SDK and Noir can interact seamlessly when the account contract enforces specific call patterns instead of dispatching arbitrary calls.

## How It Works

In a standard Aztec transaction, the flow is:

```
kernel --> account_contract.entrypoint(AppPayload)     [msg_sender = None]
                |-- token.transfer(args)               [msg_sender = account]
```

The account contract receives an `AppPayload` from the SDK, verifies a cryptographic signature, then dispatches arbitrary calls listed in the payload via `app_payload.execute_calls()`.

The **canonical account** replaces both signature verification and generic dispatch with explicit validation and execution:

```
kernel --> canonical_account.entrypoint(AppPayload)    [msg_sender = None]
                |-- SponsoredFPC.sponsor_unconditionally()   (fee sponsorship)
                |-- Token.transfer_in_private(args)          (explicit dispatch)
```

It asserts:
1. **Transaction root** -- `maybe_msg_sender().is_none()`, proving this is the kernel's initial call (not nested from another account or multicall).
2. **Fee handling** -- `fee_payment_method == EXTERNAL (0)`, confirming the SDK isn't injecting fee calls. The contract sponsors fees itself by calling `SponsoredFPC.sponsor_unconditionally()` directly.
3. **Payload structure** -- the `AppPayload` contains exactly one call at index 0; indices 1-4 must be empty (zero target address).
4. **Target validation** -- `call[0]` targets the expected token contract (stored in `PublicImmutable` during construction).
5. **Selector validation** -- `call[0]` uses the `transfer_in_private` function selector.

Instead of relying on `app_payload.execute_calls()`, the contract dispatches explicitly:
- `call_private_function(sponsored_fpc, sponsor_unconditionally, [])` for fee sponsorship
- `call_private_function_with_args_hash(token, transfer_in_private, args_hash)` for the transfer

## Project Structure

```
src/
|-- nr/
|   +-- canonical_account_contract/    # Noir contract
|       +-- src/
|           +-- main.nr
+-- ts/
    |-- canonical-account/             # TypeScript deployment utilities
    |   |-- index.ts
    |   +-- utils.ts
    |-- e2e.test.ts                    # End-to-end tests
    +-- utils.ts                       # Test infrastructure (wallet, node, fees)
```

## Usage

### TypeScript

```bash
yarn add @defi-wonderland/canonical-wallet
```

```typescript
import {
  CanonicalEmbeddedWallet,
  deployCanonicalAccount,
  SelfHandledFeePaymentMethod,
} from "@defi-wonderland/canonical-wallet/canonical-account";

// Use CanonicalEmbeddedWallet instead of EmbeddedWallet -- it overrides
// getAccountFromAddress to support custom account types via registerAccount().
const wallet = await CanonicalEmbeddedWallet.create(node, options);

const { contract, address } = await deployCanonicalAccount(
  wallet,
  tokenAddress,
  sponsoredFpcAddress,
  deployerAddress,
  { fee: { paymentMethod: sponsoredPaymentMethod } },
);

// SelfHandledFeePaymentMethod tells the SDK "fees are external" (enum 0)
// without injecting any fee calls -- the contract handles sponsorship internally.
const selfHandledFee = new SelfHandledFeePaymentMethod(sponsoredFpcAddress);

await token.methods
  .transfer_in_private(address, recipient, amount, Fr.ZERO)
  .send({ from: address, fee: { paymentMethod: selfHandledFee } });
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

### Explicit dispatch vs `execute_calls`

`AppPayload.execute_calls()` iterates all calls and dispatches them generically. For tighter control, we instead use the low-level `PrivateContext` methods directly:
- `call_private_function(address, selector, args)` -- high-level variant that hashes args and stores them in the execution cache
- `call_private_function_with_args_hash(address, selector, args_hash, is_static)` -- low-level variant used when we already have `args_hash` from the serialized payload

This lets us control the exact call sequence: fee sponsorship first (for setup-phase ordering), then the transfer.

### Self-handled fee model with `AccountFeePaymentMethodOptions`

The SDK's `DefaultAccountEntrypoint` passes a `fee_payment_method: u8` to the Noir entrypoint:
- `0 = EXTERNAL` -- another contract handles fees
- `1 = PREEXISTING_FEE_JUICE` -- account pays from its own balance
- `2 = FEE_JUICE_WITH_CLAIM` -- account pays from a balance being claimed

We enforce `EXTERNAL (0)` and call `SponsoredFPC.sponsor_unconditionally()` directly from the entrypoint. On the TS side, `SelfHandledFeePaymentMethod` sets `feePayer` to the FPC address (triggering `EXTERNAL`) but returns an empty execution payload (no calls), since the contract handles the actual FPC call.

### `SharedImmutable` does not exist in this Aztec version

The plan called for `SharedImmutable<AztecAddress>` storage. This state variable does not exist in `v4.0.0-devnet.2-patch.1`. We use `PublicImmutable<AztecAddress>` instead, which supports initialization from a public constructor and reading from private context via historical public storage proofs.

### Function selector string format

`FunctionSelector::from_signature(...)` in Noir and `FunctionSelector.fromSignature(...)` in the SDK both hash the signature string with `poseidon2_hash_bytes`. The string format encodes structs as parenthesized tuples of their fields -- `AztecAddress` becomes `(Field)`, not `AztecAddress`. So the correct signature is:

```
transfer_in_private((Field),(Field),u128,Field)
```

### Deployment cannot use `AztecAddress.ZERO`

`DeployAccountMethod.send({from: AztecAddress.ZERO})` triggers a self-deployment flow that wraps the fee payment through the account's own entrypoint via `AccountEntrypointMetaPaymentMethod`. This calls our entrypoint as a nested call, failing the `maybe_msg_sender().is_none()` check. Deploying from a real deployer address avoids this.

### Contract class must be published on-chain for public constructors

The default `DeployAccountMethod` options set `skipClassPublication: true` and `skipInstancePublication: true`. Since our constructor is `#[external("public")]`, the AVM needs the contract class bytecode on-chain. Setting both to `false` fixes the public-execution revert.

### `set_sender_for_tags` must be called before note delivery

When the token contract emits private logs (note delivery during `transfer_in_private`), it calls `get_sender_for_tags()` to determine the tag sender. Standard account contracts set this via the `AccountActions` helper. Since we bypass `AccountActions`, we must call `set_sender_for_tags(self.context.this_address())` explicitly before dispatching calls.

### Wallet integration via `EmbeddedWallet` subclass

`EmbeddedWallet.getAccountFromAddress` is `protected` and resolves accounts via `walletDB`, which only knows built-in types (`'schnorr'`, `'ecdsasecp256k1'`, `'ecdsasecp256r1'`). Custom account contracts can't be stored there. We subclass `EmbeddedWallet` as `CanonicalEmbeddedWallet`, overriding `getAccountFromAddress` to check a local registry of custom accounts first, falling back to the base implementation. The `NodeEmbeddedWallet.create` factory uses `this` polymorphism, so `CanonicalEmbeddedWallet.create(node, opts)` returns the subclass type directly.

## Connection to FPC Cold-Start

This contract validates the core primitive used in the [cold-start FPC flow](https://gist.github.com/wei3erHase/6890bf7480f70daf5a1c4899a1d44c28): using `maybe_msg_sender().is_none()` as a kernel-level proof that a function is the transaction root. The cold-start FPC will use the same mechanism to ensure that `cold_start_entrypoint` is the sole initial call, preventing batching of arbitrary revertible logic after `end_setup()`.

Key concepts validated here that carry forward:

- **`maybe_msg_sender().is_none()`** reliably enforces tx-root status from Noir
- **Explicit call dispatch** via `call_private_function` / `call_private_function_with_args_hash` gives precise control over call sequencing and phase ordering
- **Self-handled fee sponsorship** using `AccountFeePaymentMethodOptions.EXTERNAL` + direct FPC calls from the entrypoint
- **`AppPayload` serialization** for field-level validation without access to crate-private members
- **`PublicImmutable` storage** can be initialized in a public constructor and read from private entrypoints
- **The SDK can route transactions** through custom accounts via `send({from: customAccount})` using a `CanonicalEmbeddedWallet` subclass

## License

MIT
