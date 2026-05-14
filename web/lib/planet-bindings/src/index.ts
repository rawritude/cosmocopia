import { Buffer } from "buffer";
import { Address } from "@stellar/stellar-sdk";
import {
  AssembledTransaction,
  Client as ContractClient,
  ClientOptions as ContractClientOptions,
  MethodOptions,
  Result,
  Spec as ContractSpec,
} from "@stellar/stellar-sdk/contract";
import type {
  u32,
  i32,
  u64,
  i64,
  u128,
  i128,
  u256,
  i256,
  Option,
  Timepoint,
  Duration,
} from "@stellar/stellar-sdk/contract";
export * from "@stellar/stellar-sdk";
export * as contract from "@stellar/stellar-sdk/contract";
export * as rpc from "@stellar/stellar-sdk/rpc";

if (typeof window !== "undefined") {
  //@ts-ignore Buffer exists
  window.Buffer = window.Buffer || Buffer;
}


export const networks = {
  testnet: {
    networkPassphrase: "Test SDF Network ; September 2015",
    contractId: "CBIWWHZH67EATB5P4OEXDKWSY6NRGE6MTQGWIXJVYJKQKMSL265FSPWV",
  }
} as const


export const Errors = {
  1: {message:"NotAdmin"},
  2: {message:"NotOwner"},
  3: {message:"DrandUnavailable"},
  4: {message:"UnknownPlanet"},
  5: {message:"SameParent"},
  6: {message:"OnCooldown"},
  7: {message:"InvalidCareAction"},
  8: {message:"Unhealthy"},
  9: {message:"RecipientNotParentOwner"},
  10: {message:"CooldownOutOfRange"},
  11: {message:"UnknownCommitment"},
  12: {message:"CommitmentNotReady"},
  13: {message:"InvalidCommitmentKind"},
  18: {message:"PairAlreadySpent"}
}






export interface Commitment {
  commit_ledger: u32;
  committer: string;
  kind: CommitmentKind;
  target_round: u64;
  to: string;
}


/**
 * Tuple variants are required by Soroban's #[contracttype] enum encoding.
 * `Genesis(x, y)` and `Conjoin(parent_a, parent_b)`.
 */
export type CommitmentKind = {tag: "Genesis", values: readonly [i32, i32]} | {tag: "Conjoin", values: readonly [u32, u32]};





/**
 * Five vitals + last update ledger. Stats are 0..=255 and clamped on every write.
 */
export interface Vitals {
  biomass: u32;
  gravity: u32;
  hydration: u32;
  last_ledger: u32;
  spirit: u32;
  temperature: u32;
}





export interface Client {
  /**
   * Construct and simulate a care transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Apply a care action. Caller must own the planet. Extends the planet's
   * TTL — see audit Critical #4.
   * 
   * After applying the care effect, `care` re-evaluates the planet's
   * civ_signal (a 0..255 score from class-specific vital weights) and
   * ratchets the stored civ_tier up if `signal / 51` exceeds it. Care
   * never demotes — if the signal has fallen below the stored tier the
   * planet keeps its current tier until the next ratchet evaluation.
   */
  care: ({id, action}: {id: u32, action: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a name transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the token collection name.
   * 
   * # Arguments
   * 
   * * `e` - Access to the Soroban environment.
   */
  name: (options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  admin: (options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a dna_of transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  dna_of: ({id}: {id: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Buffer>>>

  /**
   * Construct and simulate a extend transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Anyone can call this to refresh a planet's persistent TTL. Useful for
   * secondary-market buyers or scripts that want to keep dormant planets
   * alive without taking a game action.
   */
  extend: ({id}: {id: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a symbol transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the token collection symbol.
   * 
   * # Arguments
   * 
   * * `e` - Access to the Soroban environment.
   */
  symbol: (options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a approve transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Gives permission to `approved` to transfer the token with `token_id` to
   * another account. The approval is cleared when the token is
   * transferred.
   * 
   * Only a single account can be approved at a time for a `token_id`.
   * To remove an approval, the approver can approve their own address,
   * effectively removing the previous approved address. Alternatively,
   * setting the `live_until_ledger` to `0` will also revoke the approval.
   * 
   * # Arguments
   * 
   * * `e` - Access to Soroban environment.
   * * `approver` - The address of the approver (should be `owner` or
   * `operator`).
   * * `approved` - The address receiving the approval.
   * * `token_id` - Token ID as a number.
   * * `live_until_ledger` - The ledger number at which the allowance
   * expires. If `live_until_ledger` is `0`, the approval is revoked.
   * 
   * # Errors
   * 
   * * [`NonFungibleTokenError::NonExistentToken`] - If the token does not
   * exist.
   * * [`NonFungibleTokenError::InvalidApprover`] - If the owner address is
   * not the actual owner of the token.
   * * [`NonFungibleTokenError::InvalidLiveUntilLedger`] - If the ledge
   */
  approve: ({approver, approved, token_id, live_until_ledger}: {approver: string, approved: string, token_id: u32, live_until_ledger: u32}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a balance transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the number of tokens owned by `account`.
   * 
   * # Arguments
   * 
   * * `e` - Access to the Soroban environment.
   * * `account` - The address for which the balance is being queried.
   */
  balance: ({account}: {account: string}, options?: MethodOptions) => Promise<AssembledTransaction<u32>>

  /**
   * Construct and simulate a migrate transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Migrate a planet to new coords. Caller must own. Extends the planet's
   * TTL — see audit Critical #4.
   */
  migrate: ({id, x, y}: {id: u32, x: i32, y: i32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a owner_of transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the owner of the token with `token_id`.
   * 
   * # Arguments
   * 
   * * `e` - Access to the Soroban environment.
   * * `token_id` - Token ID as a number.
   * 
   * # Errors
   * 
   * * [`NonFungibleTokenError::NonExistentToken`] - If the token does not
   * exist.
   */
  owner_of: ({token_id}: {token_id: u32}, options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a transfer transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Transfers the token with `token_id` from `from` to `to`.
   * 
   * WARNING: Confirmation that the recipient is capable of receiving the
   * `Non-Fungible` is the caller's responsibility; otherwise the NFT may be
   * permanently lost.
   * 
   * # Arguments
   * 
   * * `e` - Access to the Soroban environment.
   * * `from` - Account of the sender.
   * * `to` - Account of the recipient.
   * * `token_id` - Token ID as a number.
   * 
   * # Errors
   * 
   * * [`NonFungibleTokenError::IncorrectOwner`] - If the current owner
   * (before calling this function) is not `from`.
   * * [`NonFungibleTokenError::NonExistentToken`] - If the token does not
   * exist.
   * 
   * # Events
   * 
   * * topics - `["transfer", from: Address, to: Address]`
   * * data - `[token_id: u32]`
   */
  transfer: ({from, to, token_id}: {from: string, to: string, token_id: u32}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a coords_of transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  coords_of: ({id}: {id: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<readonly [i32, i32]>>>

  /**
   * Construct and simulate a latent_of transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Return the recessive allele blob (R1 + R2 per trait slot). For
   * planets minted before the dominance system shipped, returns 32 zero
   * bytes — those legacy planets carry no recessives.
   */
  latent_of: ({id}: {id: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Buffer>>>

  /**
   * Construct and simulate a set_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Admin-only: rotate the admin to a new address. Closes audit High #3 +
   * Medium upgrade-path: lets a compromised admin be replaced, and lets
   * the project move to a multisig later without redeploying.
   */
  set_admin: ({new_admin}: {new_admin: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_drand transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Admin-only: rotate the drand verifier address (audit Critical #3).
   * Use this if the canonical verifier ever needs replacing.
   */
  set_drand: ({new_drand}: {new_drand: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a token_uri transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the Uniform Resource Identifier (URI) for the token with
   * `token_id`.
   * 
   * # Arguments
   * 
   * * `e` - Access to the Soroban environment.
   * * `token_id` - Token ID as a number.
   * 
   * # Notes
   * 
   * If the token does not exist, this function is expected to panic.
   */
  token_uri: ({token_id}: {token_id: u32}, options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a vitals_of transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  vitals_of: ({id}: {id: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Vitals>>>

  /**
   * Construct and simulate a civ_tier_of transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Return the planet's stored civilization tier (0..=4). Reads the
   * `CivTier(id)` slot directly with a 0 fallback — view calls do *not*
   * project demotion based on current signal, so a tier earned through
   * care stays "on file" until the next `care` ratchet evaluation. This
   * keeps the view cheap and avoids spurious storage writes from reads.
   */
  civ_tier_of: ({id}: {id: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u32>>>

  /**
   * Construct and simulate a cooldown_of transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  cooldown_of: ({id}: {id: u32}, options?: MethodOptions) => Promise<AssembledTransaction<u32>>

  /**
   * Construct and simulate a get_approved transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the account approved for the token with `token_id`.
   * 
   * # Arguments
   * 
   * * `e` - Access to the Soroban environment.
   * * `token_id` - Token ID as a number.
   * 
   * # Errors
   * 
   * * [`NonFungibleTokenError::NonExistentToken`] - If the token does not
   * exist.
   */
  get_approved: ({token_id}: {token_id: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Option<string>>>

  /**
   * Construct and simulate a get_token_id transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the `token_id` at a given `index` in the global token list.
   * Use along with [`NonFungibleEnumerable::total_supply`] to enumerate
   * all the tokens in the contract.
   * 
   * A function to get all tokens of a contract is not provided because that
   * would be unbounded. To enumerate all tokens of a contract, use
   * [`NonFungibleEnumerable::total_supply`] to get the total number of
   * tokens and then use [`NonFungibleEnumerable::get_token_id`] to retrieve
   * each token one by one.
   * 
   * # Arguments
   * 
   * * `e` - Access to the Soroban environment.
   * * `index` - Index of the token in the global list.
   * 
   * # Errors
   * 
   * * [`crate::non_fungible::NonFungibleTokenError::TokenNotFoundInGlobalList`] - When the token
   * ID is not found in the global enumeration.
   */
  get_token_id: ({index}: {index: u32}, options?: MethodOptions) => Promise<AssembledTransaction<u32>>

  /**
   * Construct and simulate a reveal_after transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * View: at which ledger does `commitment_id` become revealable. Returns
   * `commit_ledger + MIN_REVEAL_DELAY_LEDGERS`. Frontend can compare to
   * the current ledger to decide whether to enable a "reveal" button.
   */
  reveal_after: ({commitment_id}: {commitment_id: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u32>>>

  /**
   * Construct and simulate a set_cooldown transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  set_cooldown: ({ledgers}: {ledgers: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a total_supply transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the total amount of tokens stored by the contract.
   * 
   * # Arguments
   * 
   * * `e` - Access to the Soroban environment.
   */
  total_supply: (options?: MethodOptions) => Promise<AssembledTransaction<u32>>

  /**
   * Construct and simulate a commitment_of transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the stored commitment so a watcher can show pending state.
   */
  commitment_of: ({commitment_id}: {commitment_id: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Commitment>>>

  /**
   * Construct and simulate a population_of transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Return the planet's expressed population type (0..5). Maps directly
   * to art/src/scene.ts:POPULATIONS. Returns 0 (Humanoid) for legacy
   * planets with no latent blob.
   */
  population_of: ({id}: {id: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u32>>>

  /**
   * Construct and simulate a transfer_from transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Transfers the token with `token_id` from `from` to `to` by using
   * `spender`s approval.
   * 
   * Unlike `transfer()`, which is used when the token owner initiates the
   * transfer, `transfer_from()` allows an approved third party
   * (`spender`) to transfer the token on behalf of the owner. This
   * function verifies that `spender` has the necessary approval.
   * 
   * WARNING: Confirmation that the recipient is capable of receiving the
   * `Non-Fungible` is the caller's responsibility; otherwise the NFT may be
   * permanently lost.
   * 
   * # Arguments
   * 
   * * `e` - Access to the Soroban environment.
   * * `spender` - The address authorizing the transfer.
   * * `from` - Account of the sender.
   * * `to` - Account of the recipient.
   * * `token_id` - Token ID as a number.
   * 
   * # Errors
   * 
   * * [`NonFungibleTokenError::IncorrectOwner`] - If the current owner
   * (before calling this function) is not `from`.
   * * [`NonFungibleTokenError::InsufficientApproval`] - If the spender does
   * not have a valid approval.
   * * [`NonFungibleTokenError::NonExistentToken`] - If the token does not
   * exist.
   * 
   * # Events
   */
  transfer_from: ({spender, from, to, token_id}: {spender: string, from: string, to: string, token_id: u32}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a commit_conjoin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Commit to conjoining two parents. Same anti-grinding flow as
   * commit_genesis: target_round is pinned to a future drand round so
   * the user can't peek the seed at commit time.
   * 
   * `to` must be one of the parents' owners (audit High #1).
   */
  commit_conjoin: ({parent_a, parent_b, to, observed_round}: {parent_a: u32, parent_b: u32, to: string, observed_round: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u32>>>

  /**
   * Construct and simulate a commit_genesis transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Admin-only: commit to a genesis mint. `observed_round` is the
   * caller's view of the current drand round; the contract stores
   * `target_round = observed_round + LOOKAHEAD_ROUNDS`. Reveal can land
   * after MIN_REVEAL_DELAY_LEDGERS ledgers, at which point the target
   * round's randomness exists and the user could not have predicted it
   * at commit time. Closes audit Critical #1/#2 (DNA grinding).
   */
  commit_genesis: ({to, observed_round, x, y}: {to: string, observed_round: u64, x: i32, y: i32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u32>>>

  /**
   * Construct and simulate a drand_verifier transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  drand_verifier: (options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a reveal_conjoin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Reveal a previously committed conjoin. Anyone can call.
   */
  reveal_conjoin: ({commitment_id}: {commitment_id: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u32>>>

  /**
   * Construct and simulate a reveal_genesis transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Reveal a previously committed genesis mint. Anyone can call (the
   * commitment carries the recipient) — but reveal will fail if the
   * minimum reveal delay hasn't passed or the drand round still isn't
   * available.
   */
  reveal_genesis: ({commitment_id}: {commitment_id: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u32>>>

  /**
   * Construct and simulate a approve_for_all transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Approve or remove `operator` as an operator for the owner.
   * 
   * Operators can call `transfer_from()` for any token held by `owner`,
   * and call `approve()` on behalf of `owner`.
   * 
   * # Arguments
   * 
   * * `e` - Access to Soroban environment.
   * * `owner` - The address holding the tokens.
   * * `operator` - Account to add to the set of authorized operators.
   * * `live_until_ledger` - The ledger number at which the allowance
   * expires. If `live_until_ledger` is `0`, the approval is revoked.
   * 
   * # Errors
   * 
   * * [`NonFungibleTokenError::InvalidLiveUntilLedger`] - If the ledger
   * number is less than the current ledger number.
   * 
   * # Events
   * 
   * * topics - `["approve_for_all", from: Address]`
   * * data - `[operator: Address, live_until_ledger: u32]`
   */
  approve_for_all: ({owner, operator, live_until_ledger}: {owner: string, operator: string, live_until_ledger: u32}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a get_owner_token_id transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the `token_id` owned by `owner` at a given `index` in the
   * owner's local list. Use along with
   * [`crate::non_fungible::NonFungibleToken::balance`] to enumerate all of
   * `owner`'s tokens.
   * 
   * # Arguments
   * 
   * * `e` - Access to the Soroban environment.
   * * `owner` - Account of the token's owner.
   * * `index` - Index of the token in the owner's local list.
   * 
   * # Errors
   * 
   * * [`crate::non_fungible::NonFungibleTokenError::TokenNotFoundInOwnerList`] - When the token
   * ID is not found in the owner's enumeration.
   */
  get_owner_token_id: ({owner, index}: {owner: string, index: u32}, options?: MethodOptions) => Promise<AssembledTransaction<u32>>

  /**
   * Construct and simulate a is_approved_for_all transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns whether the `operator` is allowed to manage all the assets of
   * `owner`.
   * 
   * # Arguments
   * 
   * * `e` - Access to the Soroban environment.
   * * `owner` - Account of the token's owner.
   * * `operator` - Account to be checked.
   */
  is_approved_for_all: ({owner, operator}: {owner: string, operator: string}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
        /** Constructor/Initialization Args for the contract's `__constructor` method */
        {admin, drand, uri, name, symbol}: {admin: string, drand: string, uri: string, name: string, symbol: string},
    /** Options for initializing a Client as well as for calling a method, with extras specific to deploying. */
    options: MethodOptions &
      Omit<ContractClientOptions, "contractId"> & {
        /** The hash of the Wasm blob, which must already be installed on-chain. */
        wasmHash: Buffer | string;
        /** Salt used to generate the contract's ID. Passed through to {@link Operation.createCustomContract}. Default: random. */
        salt?: Buffer | Uint8Array;
        /** The format used to decode `wasmHash`, if it's provided as a string. */
        format?: "hex" | "base64";
      }
  ): Promise<AssembledTransaction<T>> {
    return ContractClient.deploy({admin, drand, uri, name, symbol}, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "AAAABQAAAbtFbWl0dGVkIG9uIGV2ZXJ5IG5ldyBwbGFuZXQgY3JlYXRpb24gKGJvdGggZ2VuZXNpcyBtaW50IGFuZCBjb25qb2luCmNoaWxkKS4gQ29tcGxlbWVudHMg4oCUIGRvZXMgbm90IHJlcGxhY2Ug4oCUIHRoZSBPcGVuWmVwcGVsaW4gYE1pbnRgIGV2ZW50CnRoYXQgYHNlcXVlbnRpYWxfbWludGAgZmlyZXMgZm9yIGFueSBORlQgaW5kZXhlci4gYEJvcm5gIGNhcnJpZXMKQ29zbW9jb3BpYS1zcGVjaWZpYyBnZW5ldGljczogd2hpY2ggZHJhbmQgcm91bmQgc2VlZGVkIHRoZSBETkEgYW5kIGhvdwptYW55IGdlbmVyYXRpb25zIGRlZXAgdGhlIGxpbmVhZ2UgaXMuCgpPd25lciBpcyBpbiB0aGUgdG9waWMgdmVjdG9yIHNvIGluZGV4ZXJzIGNhbiBmaWx0ZXIgImFsbCBwbGFuZXRzIGJvcm4gdG8KYWRkcmVzcyBYIiB3aXRob3V0IHNjYW5uaW5nIHRoZSBlbnRpcmUgZXZlbnQgc3RyZWFtLgAAAAAAAAAABEJvcm4AAAABAAAABGJvcm4AAAAEAAAAAAAAAAVvd25lcgAAAAAAABMAAAABAAAAAAAAAAJpZAAAAAAABAAAAAAAAAAAAAAACmdlbmVyYXRpb24AAAAAAAQAAAAAAAAAAAAAAAtkcmFuZF9yb3VuZAAAAAAGAAAAAAAAAAI=",
        "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAADQAAAAAAAAAITm90QWRtaW4AAAABAAAAAAAAAAhOb3RPd25lcgAAAAIAAAAAAAAAEERyYW5kVW5hdmFpbGFibGUAAAADAAAAAAAAAA1Vbmtub3duUGxhbmV0AAAAAAAABAAAAAAAAAAKU2FtZVBhcmVudAAAAAAABQAAAAAAAAAKT25Db29sZG93bgAAAAAABgAAAAAAAAARSW52YWxpZENhcmVBY3Rpb24AAAAAAAAHAAAAAAAAAAlVbmhlYWx0aHkAAAAAAAAIAAAAAAAAABdSZWNpcGllbnROb3RQYXJlbnRPd25lcgAAAAAJAAAAAAAAABJDb29sZG93bk91dE9mUmFuZ2UAAAAAAAoAAAAAAAAAEVVua25vd25Db21taXRtZW50AAAAAAAACwAAAAAAAAASQ29tbWl0bWVudE5vdFJlYWR5AAAAAAAMAAAAAAAAABVJbnZhbGlkQ29tbWl0bWVudEtpbmQAAAAAAAAN",
        "AAAABQAAAAAAAAAAAAAABUNhcmVkAAAAAAAAAQAAAARjYXJlAAAAAgAAAAAAAAACaWQAAAAAAAQAAAAAAAAAAAAAAAZhY3Rpb24AAAAAAAQAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAABU1vdmVkAAAAAAAAAQAAAAVtb3ZlZAAAAAAAAAMAAAAAAAAAAmlkAAAAAAAEAAAAAAAAAAAAAAABeAAAAAAAAAUAAAAAAAAAAAAAAAF5AAAAAAAABQAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAAB0NvbmpvaW4AAAAAAQAAAAdjb25qb2luAAAAAAQAAAAAAAAABWNoaWxkAAAAAAAABAAAAAAAAAAAAAAACHBhcmVudF9hAAAABAAAAAAAAAAAAAAACHBhcmVudF9iAAAABAAAAAAAAAAAAAAAC2RyYW5kX3JvdW5kAAAAAAYAAAAAAAAAAg==",
        "AAAABQAAAMhFbWl0dGVkIGF0IGNvbW1pdCB0aW1lIHNvIHRoZSBmcm9udGVuZCBjYW4gc2hvdyBwZW5kaW5nIGNvbW1pdG1lbnRzIGFuZAprbm93IHdoZW4gdGhleSBiZWNvbWUgcmV2ZWFsYWJsZS4gYHRhcmdldF9yb3VuZGAgbGV0cyBhIHdhdGNoZXIgcG9sbCB0aGUKZHJhbmQgdmVyaWZpZXIgdG8gc2VlIGlmIHJhbmRvbW5lc3MgaGFzIGJlZW4gcHVibGlzaGVkLgAAAAAAAAAJQ29tbWl0dGVkAAAAAAAAAQAAAAljb21taXR0ZWQAAAAAAAAEAAAAAAAAAAljb21taXR0ZXIAAAAAAAATAAAAAQAAAAAAAAANY29tbWl0bWVudF9pZAAAAAAAAAQAAAAAAAAAAAAAAAx0YXJnZXRfcm91bmQAAAAGAAAAAAAAAAAAAAATcmV2ZWFsX2FmdGVyX2xlZGdlcgAAAAAEAAAAAAAAAAI=",
        "AAAAAQAAAAAAAAAAAAAACkNvbW1pdG1lbnQAAAAAAAUAAAAAAAAADWNvbW1pdF9sZWRnZXIAAAAAAAAEAAAAAAAAAAljb21taXR0ZXIAAAAAAAATAAAAAAAAAARraW5kAAAH0AAAAA5Db21taXRtZW50S2luZAAAAAAAAAAAAAx0YXJnZXRfcm91bmQAAAAGAAAAAAAAAAJ0bwAAAAAAEw==",
        "AAAAAAAAAbBBcHBseSBhIGNhcmUgYWN0aW9uLiBDYWxsZXIgbXVzdCBvd24gdGhlIHBsYW5ldC4gRXh0ZW5kcyB0aGUgcGxhbmV0J3MKVFRMIOKAlCBzZWUgYXVkaXQgQ3JpdGljYWwgIzQuCgpBZnRlciBhcHBseWluZyB0aGUgY2FyZSBlZmZlY3QsIGBjYXJlYCByZS1ldmFsdWF0ZXMgdGhlIHBsYW5ldCdzCmNpdl9zaWduYWwgKGEgMC4uMjU1IHNjb3JlIGZyb20gY2xhc3Mtc3BlY2lmaWMgdml0YWwgd2VpZ2h0cykgYW5kCnJhdGNoZXRzIHRoZSBzdG9yZWQgY2l2X3RpZXIgdXAgaWYgYHNpZ25hbCAvIDUxYCBleGNlZWRzIGl0LiBDYXJlCm5ldmVyIGRlbW90ZXMg4oCUIGlmIHRoZSBzaWduYWwgaGFzIGZhbGxlbiBiZWxvdyB0aGUgc3RvcmVkIHRpZXIgdGhlCnBsYW5ldCBrZWVwcyBpdHMgY3VycmVudCB0aWVyIHVudGlsIHRoZSBuZXh0IHJhdGNoZXQgZXZhbHVhdGlvbi4AAAAEY2FyZQAAAAIAAAAAAAAAAmlkAAAAAAAEAAAAAAAAAAZhY3Rpb24AAAAAAAQAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAFtSZXR1cm5zIHRoZSB0b2tlbiBjb2xsZWN0aW9uIG5hbWUuCgojIEFyZ3VtZW50cwoKKiBgZWAgLSBBY2Nlc3MgdG8gdGhlIFNvcm9iYW4gZW52aXJvbm1lbnQuAAAAAARuYW1lAAAAAAAAAAEAAAAQ",
        "AAAAAAAAAAAAAAAFYWRtaW4AAAAAAAAAAAAAAQAAABM=",
        "AAAAAAAAAAAAAAAGZG5hX29mAAAAAAABAAAAAAAAAAJpZAAAAAAABAAAAAEAAAPpAAAD7gAAACAAAAAD",
        "AAAAAAAAAK5BbnlvbmUgY2FuIGNhbGwgdGhpcyB0byByZWZyZXNoIGEgcGxhbmV0J3MgcGVyc2lzdGVudCBUVEwuIFVzZWZ1bCBmb3IKc2Vjb25kYXJ5LW1hcmtldCBidXllcnMgb3Igc2NyaXB0cyB0aGF0IHdhbnQgdG8ga2VlcCBkb3JtYW50IHBsYW5ldHMKYWxpdmUgd2l0aG91dCB0YWtpbmcgYSBnYW1lIGFjdGlvbi4AAAAAAAZleHRlbmQAAAAAAAEAAAAAAAAAAmlkAAAAAAAEAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAF1SZXR1cm5zIHRoZSB0b2tlbiBjb2xsZWN0aW9uIHN5bWJvbC4KCiMgQXJndW1lbnRzCgoqIGBlYCAtIEFjY2VzcyB0byB0aGUgU29yb2JhbiBlbnZpcm9ubWVudC4AAAAAAAAGc3ltYm9sAAAAAAAAAAAAAQAAABA=",
        "AAAABQAAAMxFbWl0dGVkIHdoZW5ldmVyIGFuIGFkbWluIGNoYW5nZXMgYSBjb250cmFjdC1sZXZlbCBjb25maWd1cmF0aW9uIHZhbHVlCihjb29sZG93biB3aW5kb3csIGFkbWluIHJvdGF0aW9uLCBkcmFuZCB2ZXJpZmllciByb3RhdGlvbikuIE9mZi1jaGFpbgppbmRleGVycyBjYW4gdXNlIHRoaXMgZm9yIGFuIGF1ZGl0IHRyYWlsIG9mIGdvdmVybmFuY2UgYWN0aW9ucy4AAAAAAAAADUNvbmZpZ0NoYW5nZWQAAAAAAAABAAAABmNvbmZpZwAAAAAAAgAAAAAAAAADa2V5AAAAABEAAAAAAAAAAAAAAAV2YWx1ZQAAAAAAAAYAAAAAAAAAAg==",
        "AAAAAgAAAHpUdXBsZSB2YXJpYW50cyBhcmUgcmVxdWlyZWQgYnkgU29yb2JhbidzICNbY29udHJhY3R0eXBlXSBlbnVtIGVuY29kaW5nLgpgR2VuZXNpcyh4LCB5KWAgYW5kIGBDb25qb2luKHBhcmVudF9hLCBwYXJlbnRfYilgLgAAAAAAAAAAAA5Db21taXRtZW50S2luZAAAAAAAAgAAAAEAAAAAAAAAB0dlbmVzaXMAAAAAAgAAAAUAAAAFAAAAAQAAAAAAAAAHQ29uam9pbgAAAAACAAAABAAAAAQ=",
        "AAAAAAAABABHaXZlcyBwZXJtaXNzaW9uIHRvIGBhcHByb3ZlZGAgdG8gdHJhbnNmZXIgdGhlIHRva2VuIHdpdGggYHRva2VuX2lkYCB0bwphbm90aGVyIGFjY291bnQuIFRoZSBhcHByb3ZhbCBpcyBjbGVhcmVkIHdoZW4gdGhlIHRva2VuIGlzCnRyYW5zZmVycmVkLgoKT25seSBhIHNpbmdsZSBhY2NvdW50IGNhbiBiZSBhcHByb3ZlZCBhdCBhIHRpbWUgZm9yIGEgYHRva2VuX2lkYC4KVG8gcmVtb3ZlIGFuIGFwcHJvdmFsLCB0aGUgYXBwcm92ZXIgY2FuIGFwcHJvdmUgdGhlaXIgb3duIGFkZHJlc3MsCmVmZmVjdGl2ZWx5IHJlbW92aW5nIHRoZSBwcmV2aW91cyBhcHByb3ZlZCBhZGRyZXNzLiBBbHRlcm5hdGl2ZWx5LApzZXR0aW5nIHRoZSBgbGl2ZV91bnRpbF9sZWRnZXJgIHRvIGAwYCB3aWxsIGFsc28gcmV2b2tlIHRoZSBhcHByb3ZhbC4KCiMgQXJndW1lbnRzCgoqIGBlYCAtIEFjY2VzcyB0byBTb3JvYmFuIGVudmlyb25tZW50LgoqIGBhcHByb3ZlcmAgLSBUaGUgYWRkcmVzcyBvZiB0aGUgYXBwcm92ZXIgKHNob3VsZCBiZSBgb3duZXJgIG9yCmBvcGVyYXRvcmApLgoqIGBhcHByb3ZlZGAgLSBUaGUgYWRkcmVzcyByZWNlaXZpbmcgdGhlIGFwcHJvdmFsLgoqIGB0b2tlbl9pZGAgLSBUb2tlbiBJRCBhcyBhIG51bWJlci4KKiBgbGl2ZV91bnRpbF9sZWRnZXJgIC0gVGhlIGxlZGdlciBudW1iZXIgYXQgd2hpY2ggdGhlIGFsbG93YW5jZQpleHBpcmVzLiBJZiBgbGl2ZV91bnRpbF9sZWRnZXJgIGlzIGAwYCwgdGhlIGFwcHJvdmFsIGlzIHJldm9rZWQuCgojIEVycm9ycwoKKiBbYE5vbkZ1bmdpYmxlVG9rZW5FcnJvcjo6Tm9uRXhpc3RlbnRUb2tlbmBdIC0gSWYgdGhlIHRva2VuIGRvZXMgbm90CmV4aXN0LgoqIFtgTm9uRnVuZ2libGVUb2tlbkVycm9yOjpJbnZhbGlkQXBwcm92ZXJgXSAtIElmIHRoZSBvd25lciBhZGRyZXNzIGlzCm5vdCB0aGUgYWN0dWFsIG93bmVyIG9mIHRoZSB0b2tlbi4KKiBbYE5vbkZ1bmdpYmxlVG9rZW5FcnJvcjo6SW52YWxpZExpdmVVbnRpbExlZGdlcmBdIC0gSWYgdGhlIGxlZGdlAAAAB2FwcHJvdmUAAAAABAAAAAAAAAAIYXBwcm92ZXIAAAATAAAAAAAAAAhhcHByb3ZlZAAAABMAAAAAAAAACHRva2VuX2lkAAAABAAAAAAAAAARbGl2ZV91bnRpbF9sZWRnZXIAAAAAAAAEAAAAAA==",
        "AAAAAAAAAKtSZXR1cm5zIHRoZSBudW1iZXIgb2YgdG9rZW5zIG93bmVkIGJ5IGBhY2NvdW50YC4KCiMgQXJndW1lbnRzCgoqIGBlYCAtIEFjY2VzcyB0byB0aGUgU29yb2JhbiBlbnZpcm9ubWVudC4KKiBgYWNjb3VudGAgLSBUaGUgYWRkcmVzcyBmb3Igd2hpY2ggdGhlIGJhbGFuY2UgaXMgYmVpbmcgcXVlcmllZC4AAAAAB2JhbGFuY2UAAAAAAQAAAAAAAAAHYWNjb3VudAAAAAATAAAAAQAAAAQ=",
        "AAAAAAAAAGRNaWdyYXRlIGEgcGxhbmV0IHRvIG5ldyBjb29yZHMuIENhbGxlciBtdXN0IG93bi4gRXh0ZW5kcyB0aGUgcGxhbmV0J3MKVFRMIOKAlCBzZWUgYXVkaXQgQ3JpdGljYWwgIzQuAAAAB21pZ3JhdGUAAAAAAwAAAAAAAAACaWQAAAAAAAQAAAAAAAAAAXgAAAAAAAAFAAAAAAAAAAF5AAAAAAAABQAAAAEAAAPpAAAAAgAAAAM=",
        "AAAABQAAAJBFbWl0dGVkIHdoZW5ldmVyIGBjYXJlYCByYXRjaGV0cyBhIHBsYW5ldCdzIGNpdl90aWVyIHVwLiBQaW5uZWQgYGZyb21gL2B0b2AKdHlwZXMgYXJlIHUzMiBiZWNhdXNlIGNvbnRyYWN0ZXZlbnQgbWFjcm9zIGRvbid0IGFjY2VwdCB1OCBkaXJlY3RseS4AAAAAAAAADkNpdlRpZXJDaGFuZ2VkAAAAAAABAAAAA2NpdgAAAAADAAAAAAAAAAJpZAAAAAAABAAAAAEAAAAAAAAABGZyb20AAAAEAAAAAAAAAAAAAAACdG8AAAAAAAQAAAAAAAAAAg==",
        "AAAAAAAAAOVSZXR1cm5zIHRoZSBvd25lciBvZiB0aGUgdG9rZW4gd2l0aCBgdG9rZW5faWRgLgoKIyBBcmd1bWVudHMKCiogYGVgIC0gQWNjZXNzIHRvIHRoZSBTb3JvYmFuIGVudmlyb25tZW50LgoqIGB0b2tlbl9pZGAgLSBUb2tlbiBJRCBhcyBhIG51bWJlci4KCiMgRXJyb3JzCgoqIFtgTm9uRnVuZ2libGVUb2tlbkVycm9yOjpOb25FeGlzdGVudFRva2VuYF0gLSBJZiB0aGUgdG9rZW4gZG9lcyBub3QKZXhpc3QuAAAAAAAACG93bmVyX29mAAAAAQAAAAAAAAAIdG9rZW5faWQAAAAEAAAAAQAAABM=",
        "AAAAAAAAAqBUcmFuc2ZlcnMgdGhlIHRva2VuIHdpdGggYHRva2VuX2lkYCBmcm9tIGBmcm9tYCB0byBgdG9gLgoKV0FSTklORzogQ29uZmlybWF0aW9uIHRoYXQgdGhlIHJlY2lwaWVudCBpcyBjYXBhYmxlIG9mIHJlY2VpdmluZyB0aGUKYE5vbi1GdW5naWJsZWAgaXMgdGhlIGNhbGxlcidzIHJlc3BvbnNpYmlsaXR5OyBvdGhlcndpc2UgdGhlIE5GVCBtYXkgYmUKcGVybWFuZW50bHkgbG9zdC4KCiMgQXJndW1lbnRzCgoqIGBlYCAtIEFjY2VzcyB0byB0aGUgU29yb2JhbiBlbnZpcm9ubWVudC4KKiBgZnJvbWAgLSBBY2NvdW50IG9mIHRoZSBzZW5kZXIuCiogYHRvYCAtIEFjY291bnQgb2YgdGhlIHJlY2lwaWVudC4KKiBgdG9rZW5faWRgIC0gVG9rZW4gSUQgYXMgYSBudW1iZXIuCgojIEVycm9ycwoKKiBbYE5vbkZ1bmdpYmxlVG9rZW5FcnJvcjo6SW5jb3JyZWN0T3duZXJgXSAtIElmIHRoZSBjdXJyZW50IG93bmVyCihiZWZvcmUgY2FsbGluZyB0aGlzIGZ1bmN0aW9uKSBpcyBub3QgYGZyb21gLgoqIFtgTm9uRnVuZ2libGVUb2tlbkVycm9yOjpOb25FeGlzdGVudFRva2VuYF0gLSBJZiB0aGUgdG9rZW4gZG9lcyBub3QKZXhpc3QuCgojIEV2ZW50cwoKKiB0b3BpY3MgLSBgWyJ0cmFuc2ZlciIsIGZyb206IEFkZHJlc3MsIHRvOiBBZGRyZXNzXWAKKiBkYXRhIC0gYFt0b2tlbl9pZDogdTMyXWAAAAAIdHJhbnNmZXIAAAADAAAAAAAAAARmcm9tAAAAEwAAAAAAAAACdG8AAAAAABMAAAAAAAAACHRva2VuX2lkAAAABAAAAAA=",
        "AAAAAAAAAAAAAAAJY29vcmRzX29mAAAAAAAAAQAAAAAAAAACaWQAAAAAAAQAAAABAAAD6QAAA+0AAAACAAAABQAAAAUAAAAD",
        "AAAAAAAAALZSZXR1cm4gdGhlIHJlY2Vzc2l2ZSBhbGxlbGUgYmxvYiAoUjEgKyBSMiBwZXIgdHJhaXQgc2xvdCkuIEZvcgpwbGFuZXRzIG1pbnRlZCBiZWZvcmUgdGhlIGRvbWluYW5jZSBzeXN0ZW0gc2hpcHBlZCwgcmV0dXJucyAzMiB6ZXJvCmJ5dGVzIOKAlCB0aG9zZSBsZWdhY3kgcGxhbmV0cyBjYXJyeSBubyByZWNlc3NpdmVzLgAAAAAACWxhdGVudF9vZgAAAAAAAAEAAAAAAAAAAmlkAAAAAAAEAAAAAQAAA+kAAAPuAAAAIAAAAAM=",
        "AAAAAAAAAMNBZG1pbi1vbmx5OiByb3RhdGUgdGhlIGFkbWluIHRvIGEgbmV3IGFkZHJlc3MuIENsb3NlcyBhdWRpdCBIaWdoICMzICsKTWVkaXVtIHVwZ3JhZGUtcGF0aDogbGV0cyBhIGNvbXByb21pc2VkIGFkbWluIGJlIHJlcGxhY2VkLCBhbmQgbGV0cwp0aGUgcHJvamVjdCBtb3ZlIHRvIGEgbXVsdGlzaWcgbGF0ZXIgd2l0aG91dCByZWRlcGxveWluZy4AAAAACXNldF9hZG1pbgAAAAAAAAEAAAAAAAAACW5ld19hZG1pbgAAAAAAABMAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAHtBZG1pbi1vbmx5OiByb3RhdGUgdGhlIGRyYW5kIHZlcmlmaWVyIGFkZHJlc3MgKGF1ZGl0IENyaXRpY2FsICMzKS4KVXNlIHRoaXMgaWYgdGhlIGNhbm9uaWNhbCB2ZXJpZmllciBldmVyIG5lZWRzIHJlcGxhY2luZy4AAAAACXNldF9kcmFuZAAAAAAAAAEAAAAAAAAACW5ld19kcmFuZAAAAAAAABMAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAPVSZXR1cm5zIHRoZSBVbmlmb3JtIFJlc291cmNlIElkZW50aWZpZXIgKFVSSSkgZm9yIHRoZSB0b2tlbiB3aXRoCmB0b2tlbl9pZGAuCgojIEFyZ3VtZW50cwoKKiBgZWAgLSBBY2Nlc3MgdG8gdGhlIFNvcm9iYW4gZW52aXJvbm1lbnQuCiogYHRva2VuX2lkYCAtIFRva2VuIElEIGFzIGEgbnVtYmVyLgoKIyBOb3RlcwoKSWYgdGhlIHRva2VuIGRvZXMgbm90IGV4aXN0LCB0aGlzIGZ1bmN0aW9uIGlzIGV4cGVjdGVkIHRvIHBhbmljLgAAAAAAAAl0b2tlbl91cmkAAAAAAAABAAAAAAAAAAh0b2tlbl9pZAAAAAQAAAABAAAAEA==",
        "AAAAAAAAAAAAAAAJdml0YWxzX29mAAAAAAAAAQAAAAAAAAACaWQAAAAAAAQAAAABAAAD6QAAB9AAAAAGVml0YWxzAAAAAAAD",
        "AAAABQAAARJFbWl0dGVkIG9uY2UgcGVyIHRyYWl0IHNsb3Qgd2hlbiBhIGNoaWxkJ3MgZXhwcmVzc2VkIEQgYnl0ZSBlcXVhbHMKbmVpdGhlciBwYXJlbnQncyB2aXNpYmxlIEQgZm9yIHRoYXQgc2xvdCDigJQgaS5lLiBhIGhpZGRlbiByZWNlc3NpdmUKc3VyZmFjZWQuIExldHMgb2ZmLWNoYWluIGluZGV4ZXJzIGJ1aWxkICJ5b3VyIHBsYW5ldCBpbmhlcml0ZWQgWCBmcm9tCmdyYW5kcGFyZW50IFkiIFVYIHdpdGhvdXQgcmUtcmVhZGluZyBib3RoIHBhcmVudCBsYXRlbnRzIChhdWRpdCBJNSkuAAAAAAAAAAAAEFJlY2Vzc2l2ZUVtZXJnZWQAAAABAAAACXJlY2Vzc2l2ZQAAAAAAAAMAAAAAAAAAAmlkAAAAAAAEAAAAAAAAAAAAAAALdHJhaXRfaW5kZXgAAAAABAAAAAAAAAAAAAAABmFsbGVsZQAAAAAABAAAAAAAAAAC",
        "AAAAAAAAAVBSZXR1cm4gdGhlIHBsYW5ldCdzIHN0b3JlZCBjaXZpbGl6YXRpb24gdGllciAoMC4uPTQpLiBSZWFkcyB0aGUKYENpdlRpZXIoaWQpYCBzbG90IGRpcmVjdGx5IHdpdGggYSAwIGZhbGxiYWNrIOKAlCB2aWV3IGNhbGxzIGRvICpub3QqCnByb2plY3QgZGVtb3Rpb24gYmFzZWQgb24gY3VycmVudCBzaWduYWwsIHNvIGEgdGllciBlYXJuZWQgdGhyb3VnaApjYXJlIHN0YXlzICJvbiBmaWxlIiB1bnRpbCB0aGUgbmV4dCBgY2FyZWAgcmF0Y2hldCBldmFsdWF0aW9uLiBUaGlzCmtlZXBzIHRoZSB2aWV3IGNoZWFwIGFuZCBhdm9pZHMgc3B1cmlvdXMgc3RvcmFnZSB3cml0ZXMgZnJvbSByZWFkcy4AAAALY2l2X3RpZXJfb2YAAAAAAQAAAAAAAAACaWQAAAAAAAQAAAABAAAD6QAAAAQAAAAD",
        "AAAAAAAAAAAAAAALY29vbGRvd25fb2YAAAAAAQAAAAAAAAACaWQAAAAAAAQAAAABAAAABA==",
        "AAAAAAAAAPFSZXR1cm5zIHRoZSBhY2NvdW50IGFwcHJvdmVkIGZvciB0aGUgdG9rZW4gd2l0aCBgdG9rZW5faWRgLgoKIyBBcmd1bWVudHMKCiogYGVgIC0gQWNjZXNzIHRvIHRoZSBTb3JvYmFuIGVudmlyb25tZW50LgoqIGB0b2tlbl9pZGAgLSBUb2tlbiBJRCBhcyBhIG51bWJlci4KCiMgRXJyb3JzCgoqIFtgTm9uRnVuZ2libGVUb2tlbkVycm9yOjpOb25FeGlzdGVudFRva2VuYF0gLSBJZiB0aGUgdG9rZW4gZG9lcyBub3QKZXhpc3QuAAAAAAAADGdldF9hcHByb3ZlZAAAAAEAAAAAAAAACHRva2VuX2lkAAAABAAAAAEAAAPoAAAAEw==",
        "AAAAAAAAAtBSZXR1cm5zIHRoZSBgdG9rZW5faWRgIGF0IGEgZ2l2ZW4gYGluZGV4YCBpbiB0aGUgZ2xvYmFsIHRva2VuIGxpc3QuClVzZSBhbG9uZyB3aXRoIFtgTm9uRnVuZ2libGVFbnVtZXJhYmxlOjp0b3RhbF9zdXBwbHlgXSB0byBlbnVtZXJhdGUKYWxsIHRoZSB0b2tlbnMgaW4gdGhlIGNvbnRyYWN0LgoKQSBmdW5jdGlvbiB0byBnZXQgYWxsIHRva2VucyBvZiBhIGNvbnRyYWN0IGlzIG5vdCBwcm92aWRlZCBiZWNhdXNlIHRoYXQKd291bGQgYmUgdW5ib3VuZGVkLiBUbyBlbnVtZXJhdGUgYWxsIHRva2VucyBvZiBhIGNvbnRyYWN0LCB1c2UKW2BOb25GdW5naWJsZUVudW1lcmFibGU6OnRvdGFsX3N1cHBseWBdIHRvIGdldCB0aGUgdG90YWwgbnVtYmVyIG9mCnRva2VucyBhbmQgdGhlbiB1c2UgW2BOb25GdW5naWJsZUVudW1lcmFibGU6OmdldF90b2tlbl9pZGBdIHRvIHJldHJpZXZlCmVhY2ggdG9rZW4gb25lIGJ5IG9uZS4KCiMgQXJndW1lbnRzCgoqIGBlYCAtIEFjY2VzcyB0byB0aGUgU29yb2JhbiBlbnZpcm9ubWVudC4KKiBgaW5kZXhgIC0gSW5kZXggb2YgdGhlIHRva2VuIGluIHRoZSBnbG9iYWwgbGlzdC4KCiMgRXJyb3JzCgoqIFtgY3JhdGU6Om5vbl9mdW5naWJsZTo6Tm9uRnVuZ2libGVUb2tlbkVycm9yOjpUb2tlbk5vdEZvdW5kSW5HbG9iYWxMaXN0YF0gLSBXaGVuIHRoZSB0b2tlbgpJRCBpcyBub3QgZm91bmQgaW4gdGhlIGdsb2JhbCBlbnVtZXJhdGlvbi4AAAAMZ2V0X3Rva2VuX2lkAAAAAQAAAAAAAAAFaW5kZXgAAAAAAAAEAAAAAQAAAAQ=",
        "AAAAAAAAAMtWaWV3OiBhdCB3aGljaCBsZWRnZXIgZG9lcyBgY29tbWl0bWVudF9pZGAgYmVjb21lIHJldmVhbGFibGUuIFJldHVybnMKYGNvbW1pdF9sZWRnZXIgKyBNSU5fUkVWRUFMX0RFTEFZX0xFREdFUlNgLiBGcm9udGVuZCBjYW4gY29tcGFyZSB0bwp0aGUgY3VycmVudCBsZWRnZXIgdG8gZGVjaWRlIHdoZXRoZXIgdG8gZW5hYmxlIGEgInJldmVhbCIgYnV0dG9uLgAAAAAMcmV2ZWFsX2FmdGVyAAAAAQAAAAAAAAANY29tbWl0bWVudF9pZAAAAAAAAAQAAAABAAAD6QAAAAQAAAAD",
        "AAAAAAAAAAAAAAAMc2V0X2Nvb2xkb3duAAAAAQAAAAAAAAAHbGVkZ2VycwAAAAAEAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAHNSZXR1cm5zIHRoZSB0b3RhbCBhbW91bnQgb2YgdG9rZW5zIHN0b3JlZCBieSB0aGUgY29udHJhY3QuCgojIEFyZ3VtZW50cwoKKiBgZWAgLSBBY2Nlc3MgdG8gdGhlIFNvcm9iYW4gZW52aXJvbm1lbnQuAAAAAAx0b3RhbF9zdXBwbHkAAAAAAAAAAQAAAAQ=",
        "AAAABQAAANJFbWl0dGVkIG9uIGV2ZXJ5IG5ldyBwbGFuZXQgY3JlYXRpb24gKGdlbmVzaXMgKyBjb25qb2luKSB3aXRoIHRoZQpleHByZXNzZWQgcG9wdWxhdGlvbiB0eXBlICgwLi41KS4gRnJvbnRlbmRzIGNhbiBpbmRleCBieSBgaWRgIHRvIGRyaXZlCiJ5b3VyIHBsYW5ldCBiaXJ0aGVkIGFuIEF2aWFuIGNvbG9ueSIgVVggd2l0aG91dCByZWFkaW5nIHRoZSBsYXRlbnQgYmxvYi4AAAAAAAAAAAATUG9wdWxhdGlvbkV4cHJlc3NlZAAAAAABAAAAA3BvcAAAAAACAAAAAAAAAAJpZAAAAAAABAAAAAEAAAAAAAAACnBvcHVsYXRpb24AAAAAAAQAAAAAAAAAAg==",
        "AAAAAAAAAAAAAAANX19jb25zdHJ1Y3RvcgAAAAAAAAUAAAAAAAAABWFkbWluAAAAAAAAEwAAAAAAAAAFZHJhbmQAAAAAAAATAAAAAAAAAAN1cmkAAAAAEAAAAAAAAAAEbmFtZQAAABAAAAAAAAAABnN5bWJvbAAAAAAAEAAAAAA=",
        "AAAAAAAAAEJSZXR1cm5zIHRoZSBzdG9yZWQgY29tbWl0bWVudCBzbyBhIHdhdGNoZXIgY2FuIHNob3cgcGVuZGluZyBzdGF0ZS4AAAAAAA1jb21taXRtZW50X29mAAAAAAAAAQAAAAAAAAANY29tbWl0bWVudF9pZAAAAAAAAAQAAAABAAAD6QAAB9AAAAAKQ29tbWl0bWVudAAAAAAAAw==",
        "AAAAAAAAAKFSZXR1cm4gdGhlIHBsYW5ldCdzIGV4cHJlc3NlZCBwb3B1bGF0aW9uIHR5cGUgKDAuLjUpLiBNYXBzIGRpcmVjdGx5CnRvIGFydC9zcmMvc2NlbmUudHM6UE9QVUxBVElPTlMuIFJldHVybnMgMCAoSHVtYW5vaWQpIGZvciBsZWdhY3kKcGxhbmV0cyB3aXRoIG5vIGxhdGVudCBibG9iLgAAAAAAAA1wb3B1bGF0aW9uX29mAAAAAAAAAQAAAAAAAAACaWQAAAAAAAQAAAABAAAD6QAAAAQAAAAD",
        "AAAAAAAABABUcmFuc2ZlcnMgdGhlIHRva2VuIHdpdGggYHRva2VuX2lkYCBmcm9tIGBmcm9tYCB0byBgdG9gIGJ5IHVzaW5nCmBzcGVuZGVyYHMgYXBwcm92YWwuCgpVbmxpa2UgYHRyYW5zZmVyKClgLCB3aGljaCBpcyB1c2VkIHdoZW4gdGhlIHRva2VuIG93bmVyIGluaXRpYXRlcyB0aGUKdHJhbnNmZXIsIGB0cmFuc2Zlcl9mcm9tKClgIGFsbG93cyBhbiBhcHByb3ZlZCB0aGlyZCBwYXJ0eQooYHNwZW5kZXJgKSB0byB0cmFuc2ZlciB0aGUgdG9rZW4gb24gYmVoYWxmIG9mIHRoZSBvd25lci4gVGhpcwpmdW5jdGlvbiB2ZXJpZmllcyB0aGF0IGBzcGVuZGVyYCBoYXMgdGhlIG5lY2Vzc2FyeSBhcHByb3ZhbC4KCldBUk5JTkc6IENvbmZpcm1hdGlvbiB0aGF0IHRoZSByZWNpcGllbnQgaXMgY2FwYWJsZSBvZiByZWNlaXZpbmcgdGhlCmBOb24tRnVuZ2libGVgIGlzIHRoZSBjYWxsZXIncyByZXNwb25zaWJpbGl0eTsgb3RoZXJ3aXNlIHRoZSBORlQgbWF5IGJlCnBlcm1hbmVudGx5IGxvc3QuCgojIEFyZ3VtZW50cwoKKiBgZWAgLSBBY2Nlc3MgdG8gdGhlIFNvcm9iYW4gZW52aXJvbm1lbnQuCiogYHNwZW5kZXJgIC0gVGhlIGFkZHJlc3MgYXV0aG9yaXppbmcgdGhlIHRyYW5zZmVyLgoqIGBmcm9tYCAtIEFjY291bnQgb2YgdGhlIHNlbmRlci4KKiBgdG9gIC0gQWNjb3VudCBvZiB0aGUgcmVjaXBpZW50LgoqIGB0b2tlbl9pZGAgLSBUb2tlbiBJRCBhcyBhIG51bWJlci4KCiMgRXJyb3JzCgoqIFtgTm9uRnVuZ2libGVUb2tlbkVycm9yOjpJbmNvcnJlY3RPd25lcmBdIC0gSWYgdGhlIGN1cnJlbnQgb3duZXIKKGJlZm9yZSBjYWxsaW5nIHRoaXMgZnVuY3Rpb24pIGlzIG5vdCBgZnJvbWAuCiogW2BOb25GdW5naWJsZVRva2VuRXJyb3I6Okluc3VmZmljaWVudEFwcHJvdmFsYF0gLSBJZiB0aGUgc3BlbmRlciBkb2VzCm5vdCBoYXZlIGEgdmFsaWQgYXBwcm92YWwuCiogW2BOb25GdW5naWJsZVRva2VuRXJyb3I6Ok5vbkV4aXN0ZW50VG9rZW5gXSAtIElmIHRoZSB0b2tlbiBkb2VzIG5vdApleGlzdC4KCiMgRXZlbnRzAAAADXRyYW5zZmVyX2Zyb20AAAAAAAAEAAAAAAAAAAdzcGVuZGVyAAAAABMAAAAAAAAABGZyb20AAAATAAAAAAAAAAJ0bwAAAAAAEwAAAAAAAAAIdG9rZW5faWQAAAAEAAAAAA==",
        "AAAAAAAAAOVDb21taXQgdG8gY29uam9pbmluZyB0d28gcGFyZW50cy4gU2FtZSBhbnRpLWdyaW5kaW5nIGZsb3cgYXMKY29tbWl0X2dlbmVzaXM6IHRhcmdldF9yb3VuZCBpcyBwaW5uZWQgdG8gYSBmdXR1cmUgZHJhbmQgcm91bmQgc28KdGhlIHVzZXIgY2FuJ3QgcGVlayB0aGUgc2VlZCBhdCBjb21taXQgdGltZS4KCmB0b2AgbXVzdCBiZSBvbmUgb2YgdGhlIHBhcmVudHMnIG93bmVycyAoYXVkaXQgSGlnaCAjMSkuAAAAAAAADmNvbW1pdF9jb25qb2luAAAAAAAEAAAAAAAAAAhwYXJlbnRfYQAAAAQAAAAAAAAACHBhcmVudF9iAAAABAAAAAAAAAACdG8AAAAAABMAAAAAAAAADm9ic2VydmVkX3JvdW5kAAAAAAAGAAAAAQAAA+kAAAAEAAAAAw==",
        "AAAAAAAAAYBBZG1pbi1vbmx5OiBjb21taXQgdG8gYSBnZW5lc2lzIG1pbnQuIGBvYnNlcnZlZF9yb3VuZGAgaXMgdGhlCmNhbGxlcidzIHZpZXcgb2YgdGhlIGN1cnJlbnQgZHJhbmQgcm91bmQ7IHRoZSBjb250cmFjdCBzdG9yZXMKYHRhcmdldF9yb3VuZCA9IG9ic2VydmVkX3JvdW5kICsgTE9PS0FIRUFEX1JPVU5EU2AuIFJldmVhbCBjYW4gbGFuZAphZnRlciBNSU5fUkVWRUFMX0RFTEFZX0xFREdFUlMgbGVkZ2VycywgYXQgd2hpY2ggcG9pbnQgdGhlIHRhcmdldApyb3VuZCdzIHJhbmRvbW5lc3MgZXhpc3RzIGFuZCB0aGUgdXNlciBjb3VsZCBub3QgaGF2ZSBwcmVkaWN0ZWQgaXQKYXQgY29tbWl0IHRpbWUuIENsb3NlcyBhdWRpdCBDcml0aWNhbCAjMS8jMiAoRE5BIGdyaW5kaW5nKS4AAAAOY29tbWl0X2dlbmVzaXMAAAAAAAQAAAAAAAAAAnRvAAAAAAATAAAAAAAAAA5vYnNlcnZlZF9yb3VuZAAAAAAABgAAAAAAAAABeAAAAAAAAAUAAAAAAAAAAXkAAAAAAAAFAAAAAQAAA+kAAAAEAAAAAw==",
        "AAAAAAAAAAAAAAAOZHJhbmRfdmVyaWZpZXIAAAAAAAAAAAABAAAAEw==",
        "AAAAAAAAADdSZXZlYWwgYSBwcmV2aW91c2x5IGNvbW1pdHRlZCBjb25qb2luLiBBbnlvbmUgY2FuIGNhbGwuAAAAAA5yZXZlYWxfY29uam9pbgAAAAAAAQAAAAAAAAANY29tbWl0bWVudF9pZAAAAAAAAAQAAAABAAAD6QAAAAQAAAAD",
        "AAAAAAAAAM9SZXZlYWwgYSBwcmV2aW91c2x5IGNvbW1pdHRlZCBnZW5lc2lzIG1pbnQuIEFueW9uZSBjYW4gY2FsbCAodGhlCmNvbW1pdG1lbnQgY2FycmllcyB0aGUgcmVjaXBpZW50KSDigJQgYnV0IHJldmVhbCB3aWxsIGZhaWwgaWYgdGhlCm1pbmltdW0gcmV2ZWFsIGRlbGF5IGhhc24ndCBwYXNzZWQgb3IgdGhlIGRyYW5kIHJvdW5kIHN0aWxsIGlzbid0CmF2YWlsYWJsZS4AAAAADnJldmVhbF9nZW5lc2lzAAAAAAABAAAAAAAAAA1jb21taXRtZW50X2lkAAAAAAAABAAAAAEAAAPpAAAABAAAAAM=",
        "AAAAAAAAAr9BcHByb3ZlIG9yIHJlbW92ZSBgb3BlcmF0b3JgIGFzIGFuIG9wZXJhdG9yIGZvciB0aGUgb3duZXIuCgpPcGVyYXRvcnMgY2FuIGNhbGwgYHRyYW5zZmVyX2Zyb20oKWAgZm9yIGFueSB0b2tlbiBoZWxkIGJ5IGBvd25lcmAsCmFuZCBjYWxsIGBhcHByb3ZlKClgIG9uIGJlaGFsZiBvZiBgb3duZXJgLgoKIyBBcmd1bWVudHMKCiogYGVgIC0gQWNjZXNzIHRvIFNvcm9iYW4gZW52aXJvbm1lbnQuCiogYG93bmVyYCAtIFRoZSBhZGRyZXNzIGhvbGRpbmcgdGhlIHRva2Vucy4KKiBgb3BlcmF0b3JgIC0gQWNjb3VudCB0byBhZGQgdG8gdGhlIHNldCBvZiBhdXRob3JpemVkIG9wZXJhdG9ycy4KKiBgbGl2ZV91bnRpbF9sZWRnZXJgIC0gVGhlIGxlZGdlciBudW1iZXIgYXQgd2hpY2ggdGhlIGFsbG93YW5jZQpleHBpcmVzLiBJZiBgbGl2ZV91bnRpbF9sZWRnZXJgIGlzIGAwYCwgdGhlIGFwcHJvdmFsIGlzIHJldm9rZWQuCgojIEVycm9ycwoKKiBbYE5vbkZ1bmdpYmxlVG9rZW5FcnJvcjo6SW52YWxpZExpdmVVbnRpbExlZGdlcmBdIC0gSWYgdGhlIGxlZGdlcgpudW1iZXIgaXMgbGVzcyB0aGFuIHRoZSBjdXJyZW50IGxlZGdlciBudW1iZXIuCgojIEV2ZW50cwoKKiB0b3BpY3MgLSBgWyJhcHByb3ZlX2Zvcl9hbGwiLCBmcm9tOiBBZGRyZXNzXWAKKiBkYXRhIC0gYFtvcGVyYXRvcjogQWRkcmVzcywgbGl2ZV91bnRpbF9sZWRnZXI6IHUzMl1gAAAAAA9hcHByb3ZlX2Zvcl9hbGwAAAAAAwAAAAAAAAAFb3duZXIAAAAAAAATAAAAAAAAAAhvcGVyYXRvcgAAABMAAAAAAAAAEWxpdmVfdW50aWxfbGVkZ2VyAAAAAAAABAAAAAA=",
        "AAAAAAAAAe1SZXR1cm5zIHRoZSBgdG9rZW5faWRgIG93bmVkIGJ5IGBvd25lcmAgYXQgYSBnaXZlbiBgaW5kZXhgIGluIHRoZQpvd25lcidzIGxvY2FsIGxpc3QuIFVzZSBhbG9uZyB3aXRoCltgY3JhdGU6Om5vbl9mdW5naWJsZTo6Tm9uRnVuZ2libGVUb2tlbjo6YmFsYW5jZWBdIHRvIGVudW1lcmF0ZSBhbGwgb2YKYG93bmVyYCdzIHRva2Vucy4KCiMgQXJndW1lbnRzCgoqIGBlYCAtIEFjY2VzcyB0byB0aGUgU29yb2JhbiBlbnZpcm9ubWVudC4KKiBgb3duZXJgIC0gQWNjb3VudCBvZiB0aGUgdG9rZW4ncyBvd25lci4KKiBgaW5kZXhgIC0gSW5kZXggb2YgdGhlIHRva2VuIGluIHRoZSBvd25lcidzIGxvY2FsIGxpc3QuCgojIEVycm9ycwoKKiBbYGNyYXRlOjpub25fZnVuZ2libGU6Ok5vbkZ1bmdpYmxlVG9rZW5FcnJvcjo6VG9rZW5Ob3RGb3VuZEluT3duZXJMaXN0YF0gLSBXaGVuIHRoZSB0b2tlbgpJRCBpcyBub3QgZm91bmQgaW4gdGhlIG93bmVyJ3MgZW51bWVyYXRpb24uAAAAAAAAEmdldF9vd25lcl90b2tlbl9pZAAAAAAAAgAAAAAAAAAFb3duZXIAAAAAAAATAAAAAAAAAAVpbmRleAAAAAAAAAQAAAABAAAABA==",
        "AAAAAAAAANdSZXR1cm5zIHdoZXRoZXIgdGhlIGBvcGVyYXRvcmAgaXMgYWxsb3dlZCB0byBtYW5hZ2UgYWxsIHRoZSBhc3NldHMgb2YKYG93bmVyYC4KCiMgQXJndW1lbnRzCgoqIGBlYCAtIEFjY2VzcyB0byB0aGUgU29yb2JhbiBlbnZpcm9ubWVudC4KKiBgb3duZXJgIC0gQWNjb3VudCBvZiB0aGUgdG9rZW4ncyBvd25lci4KKiBgb3BlcmF0b3JgIC0gQWNjb3VudCB0byBiZSBjaGVja2VkLgAAAAATaXNfYXBwcm92ZWRfZm9yX2FsbAAAAAACAAAAAAAAAAVvd25lcgAAAAAAABMAAAAAAAAACG9wZXJhdG9yAAAAEwAAAAEAAAAB",
        "AAAAAQAAAE9GaXZlIHZpdGFscyArIGxhc3QgdXBkYXRlIGxlZGdlci4gU3RhdHMgYXJlIDAuLj0yNTUgYW5kIGNsYW1wZWQgb24gZXZlcnkgd3JpdGUuAAAAAAAAAAAGVml0YWxzAAAAAAAGAAAAAAAAAAdiaW9tYXNzAAAAAAQAAAAAAAAAB2dyYXZpdHkAAAAABAAAAAAAAAAJaHlkcmF0aW9uAAAAAAAABAAAAAAAAAALbGFzdF9sZWRnZXIAAAAABAAAAAAAAAAGc3Bpcml0AAAAAAAEAAAAAAAAAAt0ZW1wZXJhdHVyZQAAAAAE",
        "AAAABQAAACVFdmVudCBlbWl0dGVkIHdoZW4gYSB0b2tlbiBpcyBtaW50ZWQuAAAAAAAAAAAAAARNaW50AAAAAQAAAARtaW50AAAAAgAAAAAAAAACdG8AAAAAABMAAAABAAAAAAAAAAh0b2tlbl9pZAAAAAQAAAAAAAAAAg==",
        "AAAABQAAACpFdmVudCBlbWl0dGVkIHdoZW4gYW4gYXBwcm92YWwgaXMgZ3JhbnRlZC4AAAAAAAAAAAAHQXBwcm92ZQAAAAABAAAAB2FwcHJvdmUAAAAABAAAAAAAAAAIYXBwcm92ZXIAAAATAAAAAQAAAAAAAAAIdG9rZW5faWQAAAAEAAAAAQAAAAAAAAAIYXBwcm92ZWQAAAATAAAAAAAAAAAAAAARbGl2ZV91bnRpbF9sZWRnZXIAAAAAAAAEAAAAAAAAAAI=",
        "AAAABQAAACpFdmVudCBlbWl0dGVkIHdoZW4gYSB0b2tlbiBpcyB0cmFuc2ZlcnJlZC4AAAAAAAAAAAAIVHJhbnNmZXIAAAABAAAACHRyYW5zZmVyAAAAAwAAAAAAAAAEZnJvbQAAABMAAAABAAAAAAAAAAJ0bwAAAAAAEwAAAAEAAAAAAAAACHRva2VuX2lkAAAABAAAAAAAAAAC",
        "AAAABQAAADZFdmVudCBlbWl0dGVkIHdoZW4gYXBwcm92YWwgZm9yIGFsbCB0b2tlbnMgaXMgZ3JhbnRlZC4AAAAAAAAAAAANQXBwcm92ZUZvckFsbAAAAAAAAAEAAAAPYXBwcm92ZV9mb3JfYWxsAAAAAAMAAAAAAAAABW93bmVyAAAAAAAAEwAAAAEAAAAAAAAACG9wZXJhdG9yAAAAEwAAAAAAAAAAAAAAEWxpdmVfdW50aWxfbGVkZ2VyAAAAAAAABAAAAAAAAAAC" ]),
      options
    )
  }
  public readonly fromJSON = {
    care: this.txFromJSON<Result<void>>,
        name: this.txFromJSON<string>,
        admin: this.txFromJSON<string>,
        dna_of: this.txFromJSON<Result<Buffer>>,
        extend: this.txFromJSON<Result<void>>,
        symbol: this.txFromJSON<string>,
        approve: this.txFromJSON<null>,
        balance: this.txFromJSON<u32>,
        migrate: this.txFromJSON<Result<void>>,
        owner_of: this.txFromJSON<string>,
        transfer: this.txFromJSON<null>,
        coords_of: this.txFromJSON<Result<readonly [i32, i32]>>,
        latent_of: this.txFromJSON<Result<Buffer>>,
        set_admin: this.txFromJSON<Result<void>>,
        set_drand: this.txFromJSON<Result<void>>,
        token_uri: this.txFromJSON<string>,
        vitals_of: this.txFromJSON<Result<Vitals>>,
        civ_tier_of: this.txFromJSON<Result<u32>>,
        cooldown_of: this.txFromJSON<u32>,
        get_approved: this.txFromJSON<Option<string>>,
        get_token_id: this.txFromJSON<u32>,
        reveal_after: this.txFromJSON<Result<u32>>,
        set_cooldown: this.txFromJSON<Result<void>>,
        total_supply: this.txFromJSON<u32>,
        commitment_of: this.txFromJSON<Result<Commitment>>,
        population_of: this.txFromJSON<Result<u32>>,
        transfer_from: this.txFromJSON<null>,
        commit_conjoin: this.txFromJSON<Result<u32>>,
        commit_genesis: this.txFromJSON<Result<u32>>,
        drand_verifier: this.txFromJSON<string>,
        reveal_conjoin: this.txFromJSON<Result<u32>>,
        reveal_genesis: this.txFromJSON<Result<u32>>,
        approve_for_all: this.txFromJSON<null>,
        get_owner_token_id: this.txFromJSON<u32>,
        is_approved_for_all: this.txFromJSON<boolean>
  }
}