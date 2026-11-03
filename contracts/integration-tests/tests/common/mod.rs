//! Shared sandbox setup: run the tests on the same protocol version as NEAR mainnet.
//!
//! nearcore 2.13.4 is the newest release whose stable protocol is 86 (mainnet ran
//! protocol 86 on 2026-11-03). A sandbox on 2.14.x would run protocol 88 and accept
//! host imports that mainnet rejects at deploy time. Override with
//! NEARBI_SANDBOX_VERSION / NEARBI_SANDBOX_PROTOCOL when mainnet upgrades.
use near_workspaces::network::Sandbox;
use near_workspaces::Worker;

pub const SANDBOX_VERSION: &str = "2.13.4";
pub const SANDBOX_PROTOCOL: u32 = 86;

pub async fn sandbox() -> anyhow::Result<Worker<Sandbox>> {
    let version = std::env::var("NEARBI_SANDBOX_VERSION").unwrap_or_else(|_| SANDBOX_VERSION.into());
    let want: u32 = std::env::var("NEARBI_SANDBOX_PROTOCOL")
        .ok()
        .map(|v| v.parse().expect("NEARBI_SANDBOX_PROTOCOL"))
        .unwrap_or(SANDBOX_PROTOCOL);
    let worker = near_workspaces::sandbox_with_version(&version).await?;
    let got = worker.status().await?.protocol_version;
    anyhow::ensure!(got == want, "sandbox {version} runs protocol {got}, expected {want}");
    Ok(worker)
}
