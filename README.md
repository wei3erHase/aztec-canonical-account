# Canonical Wallet

Schnorr account contract for Aztec.

## Overview

This repo provides the Schnorr account contract (`schnorr_account_contract`) — a standard Aztec account that stores the signing public key in `SinglePrivateImmutable` storage via an initializer.

## Project Structure

```
src/
├── nr/
│   └── schnorr_account_contract/   # Noir contract
│       └── src/
│           ├── main.nr
│           └── public_key_note.nr
└── ts/
    ├── schnorr-account/             # TypeScript deployment utilities
    │   ├── index.ts
    │   └── utils.ts
    ├── e2e.test.ts
    └── utils.ts
```

## Usage

### Add the dependency

In your contract's `Nargo.toml`:

```toml
[dependencies]
schnorr_account_contract = { path = "../path/to/canonical-wallet/src/nr/schnorr_account_contract" }
```

Or for TypeScript:

```bash
yarn add @defi-wonderland/canonical-wallet
```

```typescript
import {
  deploySchnorrAccount,
} from "@defi-wonderland/canonical-wallet/schnorr-account";

const { contract, secretKey } = await deploySchnorrAccount(wallet, {
  secretKey: Fr.random(),
  fee: { paymentMethod: sponsoredPaymentMethod },
});
```

## Development

### Prerequisites

- [Aztec CLI](https://docs.aztec.network/)
- [Noir](https://noir-lang.org/) (`>=1.0.0`)
- Node.js (`>=22.0.0`)
- Yarn (`>=1.22.0`)

### Setup

```bash
yarn install
```

### Build

```bash
yarn ccc  # Clean, compile Noir contracts, and generate TypeScript artifacts
```

### Test

```bash
yarn test
yarn test:nr   # Noir only
yarn test:js   # TypeScript only
```

## License

MIT
