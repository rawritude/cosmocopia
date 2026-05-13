use soroban_sdk::{contractclient, BytesN, Env};

// The trait body is consumed by #[contractclient] to generate `DrandClient`;
// the trait itself is unused at the type level, hence the allow.
#[allow(dead_code)]
#[contractclient(name = "DrandClient")]
pub trait DrandVerifier {
    fn latest(env: Env) -> Option<(u64, BytesN<32>)>;
    fn get(env: Env, round: u64) -> Option<BytesN<32>>;
}
