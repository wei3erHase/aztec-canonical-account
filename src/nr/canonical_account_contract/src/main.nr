//! # Canonical Account Contract
//!
//! An account contract that validates calls against a specific token address
//! and function selector, then forwards execution. No signature verification
//! is performed -- every transaction to this account is accepted.
//!
//! This is a stepping stone toward the FPC cold-start flow where the account
//! contract acts as a restricted entrypoint for a known set of operations.

use aztec::macros::aztec;

#[aztec]
pub contract CanonicalAccount {
    use aztec::{
        authwit::entrypoint::app::AppPayload,
        macros::{
            functions::{allow_phase_change, external, initializer, noinitcheck},
            storage::storage,
        },
        oracle::notes::set_sender_for_tags,
        protocol::{
            abis::function_selector::FunctionSelector,
            address::AztecAddress,
            traits::{FromField, Serialize},
        },
        state_vars::PublicImmutable,
    };

    // AppPayload serialization layout (per FunctionCall, 6 fields each):
    //   [0] args_hash, [1] function_selector, [2] target_address,
    //   [3] is_public, [4] hide_msg_sender, [5] is_static
    // With ACCOUNT_MAX_CALLS = 5 calls => 30 fields, then tx_nonce => 31 total.
    global FIELDS_PER_CALL: u32 = 6;
    global TARGET_ADDRESS_OFFSET: u32 = 2;
    global FUNCTION_SELECTOR_OFFSET: u32 = 1;

    #[storage]
    struct Storage<Context> {
        token: PublicImmutable<AztecAddress, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor(token: AztecAddress) {
        self.storage.token.initialize(token);
    }

    /// Restricted entrypoint: validates the payload contains a call to the
    /// expected token's `transfer_in_private`, then forwards all calls
    /// (including fee-related calls like `sponsor_unconditionally`).
    #[external("private")]
    #[noinitcheck]
    #[allow_phase_change]
    fn entrypoint(app_payload: AppPayload, _fee_payment_method: u8, _cancellable: bool) {
        assert(self.context.maybe_msg_sender().is_none(), "must be tx entrypoint");

        let expected_token = self.storage.token.read();
        let expected_selector =
            FunctionSelector::from_signature("transfer_in_private((Field),(Field),u128,Field)");

        // AppPayload.function_calls is crate-private, so we serialize to access
        // the individual FunctionCall fields by their known offsets.
        let fields = app_payload.serialize();
        let mut found_transfer = false;

        for i in 0..5 {
            let offset = i * FIELDS_PER_CALL;
            let target = AztecAddress::from_field(fields[offset + TARGET_ADDRESS_OFFSET]);

            if target == expected_token {
                let selector =
                    FunctionSelector::from_field(fields[offset + FUNCTION_SELECTOR_OFFSET]);
                assert(selector == expected_selector, "invalid selector for token call");
                found_transfer = true;
            }
        }

        assert(found_transfer, "transfer call not found in payload");

        // Safety: we trust the oracle to correctly set the tag sender for note delivery
        unsafe { set_sender_for_tags(self.context.this_address()) };
        app_payload.execute_calls(self.context);
    }
}
