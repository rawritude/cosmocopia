use soroban_sdk::{contractclient, BytesN, Env};

#[contractclient(name = "DrandClient")]
pub trait DrandVerifier {
    fn latest(env: Env) -> Option<(u64, BytesN<32>)>;
    fn get(env: Env, round: u64) -> Option<BytesN<32>>;
}
