//! # Canonical Account Contract
//!
//! A restricted account entrypoint that enforces a single `transfer_in_private`
//! call to a known token, with fee sponsorship handled internally via the
//! SponsoredFPC. No signature verification -- every transaction is accepted.

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
    global FIELDS_PER_CALL: u32 = 6;
    global ARGS_HASH_OFFSET: u32 = 0;
    global FUNCTION_SELECTOR_OFFSET: u32 = 1;
    global TARGET_ADDRESS_OFFSET: u32 = 2;

    // AccountFeePaymentMethodOptions::EXTERNAL -- signals that fee payment
    // is handled by another contract, not the account itself.
    global FEE_EXTERNAL: u8 = 0;

    #[storage]
    struct Storage<Context> {
        token: PublicImmutable<AztecAddress, Context>,
        sponsored_fpc: PublicImmutable<AztecAddress, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor(token: AztecAddress, sponsored_fpc: AztecAddress) {
        self.storage.token.initialize(token);
        self.storage.sponsored_fpc.initialize(sponsored_fpc);
    }

    /// Restricted entrypoint that:
    ///  1. Asserts this is the transaction root (msg_sender == None)
    ///  2. Asserts fee_payment_method == EXTERNAL (contract sponsors fees itself)
    ///  3. Validates call[0] targets the expected token with transfer_in_private
    ///  4. Validates calls[1..4] are empty (exactly one call in payload)
    ///  5. Calls SponsoredFPC.sponsor_unconditionally() for fee sponsorship
    ///  6. Dispatches the transfer via call_private_function_with_args_hash
    #[external("private")]
    #[noinitcheck]
    #[allow_phase_change]
    fn entrypoint(app_payload: AppPayload, fee_payment_method: u8, _cancellable: bool) {
        assert(self.context.maybe_msg_sender().is_none(), "must be tx entrypoint");
        assert(fee_payment_method == FEE_EXTERNAL, "fee must be externally handled");

        let expected_token = self.storage.token.read();
        let expected_selector =
            FunctionSelector::from_signature("transfer_in_private((Field),(Field),u128,Field)");

        let fields = app_payload.serialize();

        // call[0] must be transfer_in_private targeting the expected token
        let target = AztecAddress::from_field(fields[TARGET_ADDRESS_OFFSET]);
        assert(target == expected_token, "call must target the expected token");

        let selector = FunctionSelector::from_field(fields[FUNCTION_SELECTOR_OFFSET]);
        assert(selector == expected_selector, "call must use transfer_in_private selector");

        let args_hash = fields[ARGS_HASH_OFFSET];

        // calls[1..4] must be empty
        for i in 1..5 {
            let offset = i * FIELDS_PER_CALL;
            let t = AztecAddress::from_field(fields[offset + TARGET_ADDRESS_OFFSET]);
            assert(t.is_zero(), "payload must contain exactly one call");
        }

        // Safety: we trust the oracle to correctly set the tag sender for note delivery
        unsafe { set_sender_for_tags(self.context.this_address()) };

        // Sponsor fees via SponsoredFPC (must come before app call for phase ordering)
        let sponsored_fpc = self.storage.sponsored_fpc.read();
        let sponsor_selector = FunctionSelector::from_signature("sponsor_unconditionally()");
        let _sponsor = self.context.call_private_function(sponsored_fpc, sponsor_selector, []);

        // Dispatch the transfer explicitly
        let _transfer = self.context.call_private_function_with_args_hash(
            expected_token,
            expected_selector,
            args_hash,
            false,
        );
    }
}
