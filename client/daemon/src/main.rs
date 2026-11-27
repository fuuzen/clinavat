use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

use clinavat_daemon::bootstrap::{
    normalize_hub_url, BootstrapClient, BootstrapOutcome, TrustStore,
};
use clinavat_daemon::identity::DeviceIdentity;
use clinavat_daemon::transport::TransportMode;
use clinavat_daemon::{
    ensure_crypto_provider, init_process_umask, DaemonConfig, DaemonEvent, DaemonState, DaemonSupervisor,
};
use serde_json::json;

fn main() -> ExitCode {
    // Capture process umask before starting the multi-threaded Tokio runtime (L-a).
    init_process_umask();
    ensure_crypto_provider();
    let runtime = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(err) => {
            eprintln!("failed to initialize async runtime: {err}");
            return ExitCode::FAILURE;
        }
    };
    runtime.block_on(async_main())
}

async fn async_main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(cmd) = args.first().map(String::as_str) else {
        print_usage();
        return ExitCode::from(2);
    };

    match cmd {
        "identity" => cmd_identity(&args[1..]),
        "connect" => cmd_connect(&args[1..]).await,
        "status" => cmd_status(&args[1..]).await,
        "-h" | "--help" | "help" => {
            print_usage();
            ExitCode::SUCCESS
        }
        other => {
            eprintln!("unknown subcommand: {other}");
            print_usage();
            ExitCode::from(2)
        }
    }
}

fn print_usage() {
    eprintln!(
        "Usage:\n  \
         clinavat-agent identity [--state-dir <dir>]\n  \
         clinavat-agent connect --hub <url> [--state-dir <dir>] [--transport auto|ws|tcp] [--heartbeat-secs <n>] [--expect-fingerprint <fp>] [--stop-on-mismatch]\n  \
         clinavat-agent status [--state-dir <dir>] [--hub <url>]"
    );
}

fn take_flag(args: &[String], name: &str) -> Result<Option<String>, String> {
    let mut i = 0;
    while i < args.len() {
        if args[i] == name {
            let Some(val) = args.get(i + 1) else {
                return Err(format!("missing value for {name}"));
            };
            return Ok(Some(val.clone()));
        }
        i += 1;
    }
    Ok(None)
}

fn has_flag(args: &[String], name: &str) -> bool {
    args.iter().any(|a| a == name)
}

fn cmd_identity(args: &[String]) -> ExitCode {
    let state_dir = match take_flag(args, "--state-dir") {
        Ok(val) => val.map(PathBuf::from),
        Err(msg) => {
            eprintln!("{msg}");
            return ExitCode::from(2);
        }
    };
    match DeviceIdentity::load_or_create(state_dir) {
        Ok(id) => {
            println!("{}", serde_json::to_string_pretty(&id).unwrap_or_default());
            ExitCode::SUCCESS
        }
        Err(err) => {
            eprintln!("failed to load identity: {err}");
            ExitCode::FAILURE
        }
    }
}

async fn cmd_status(args: &[String]) -> ExitCode {
    let state_dir = match take_flag(args, "--state-dir") {
        Ok(val) => val.map(PathBuf::from),
        Err(msg) => {
            eprintln!("{msg}");
            return ExitCode::from(2);
        }
    };
    let hub_raw = match take_flag(args, "--hub") {
        Ok(val) => val,
        Err(msg) => {
            eprintln!("{msg}");
            return ExitCode::from(2);
        }
    };
    let identity = match DeviceIdentity::load_or_create(state_dir) {
        Ok(id) => id,
        Err(err) => {
            eprintln!("failed to load identity: {err}");
            return ExitCode::FAILURE;
        }
    };
    let trust_store = TrustStore::new(identity.state_dir());
    let trusted_hubs = trust_store.load_all().unwrap_or_default();

    let mut report = json!({
        "identity": identity,
        "stateDir": identity.state_dir(),
        "trustedHubs": trusted_hubs,
    });

    if let Some(hub) = hub_raw {
        match probe_hub(&hub, &identity, &trust_store).await {
            Ok(probe) => {
                report["hubProbe"] = probe;
            }
            Err(err) => {
                report["hubProbe"] = json!({ "status": "error", "error": err });
            }
        }
    }
    println!("{}", serde_json::to_string_pretty(&report).unwrap_or_default());
    ExitCode::SUCCESS
}

async fn probe_hub(
    hub_raw: &str,
    identity: &DeviceIdentity,
    trust_store: &TrustStore,
) -> Result<serde_json::Value, String> {
    let (hub_url, hub_key) = normalize_hub_url(hub_raw).map_err(|e| e.to_string())?;
    let client = BootstrapClient::new().map_err(|e| e.to_string())?;
    let outcome = client
        .bootstrap(&hub_url, &hub_key, identity, trust_store, None)
        .await
        .map_err(|e| e.to_string())?;
    Ok(match outcome {
        BootstrapOutcome::Ready(info) => json!({ "status": "ready", "info": info }),
        BootstrapOutcome::Unregistered => json!({ "status": "unregistered" }),
        BootstrapOutcome::Suspended => json!({ "status": "suspended" }),
        BootstrapOutcome::Maintenance { message } => json!({ "status": "maintenance", "message": message }),
        BootstrapOutcome::RateLimited { retry_after_secs } => {
            json!({ "status": "rateLimited", "retryAfterSecs": retry_after_secs })
        }
        BootstrapOutcome::Unauthorized { error } => json!({ "status": "unauthorized", "error": error }),
        BootstrapOutcome::UntrustedFirstConnect { hub_key, actual, .. } => json!({
            "status": "awaiting_fingerprint",
            "reason": "untrusted_http",
            "hubKey": hub_key,
            "hubUrl": hub_url.as_str(),
            "host": hub_url.host_str().unwrap_or_default(),
            "hostKeyFingerprint": actual,
        }),
        BootstrapOutcome::FingerprintMismatch { hub_key, expected, actual, .. } => json!({
            "status": "awaiting_fingerprint",
            "reason": "changed",
            "hubKey": hub_key,
            "hubUrl": hub_url.as_str(),
            "host": hub_url.host_str().unwrap_or_default(),
            "expectedFingerprint": expected,
            "hostKeyFingerprint": actual,
        }),
    })
}

async fn cmd_connect(args: &[String]) -> ExitCode {
    let hub_url = match take_flag(args, "--hub") {
        Ok(Some(url)) => url,
        Ok(None) => {
            eprintln!("connect requires --hub <url>");
            return ExitCode::from(2);
        }
        Err(msg) => {
            eprintln!("{msg}");
            return ExitCode::from(2);
        }
    };
    let state_dir = match take_flag(args, "--state-dir") {
        Ok(val) => val.map(PathBuf::from),
        Err(msg) => {
            eprintln!("{msg}");
            return ExitCode::from(2);
        }
    };
    let transport_mode = match take_flag(args, "--transport") {
        Ok(Some(raw)) => match TransportMode::parse(&raw) {
            Some(mode) => mode,
            None => {
                eprintln!("invalid --transport value: {raw} (expected auto|ws|tcp)");
                return ExitCode::from(2);
            }
        },
        Ok(None) => TransportMode::WsThenTcp,
        Err(msg) => {
            eprintln!("{msg}");
            return ExitCode::from(2);
        }
    };
    let heartbeat_secs: u64 = match take_flag(args, "--heartbeat-secs") {
        Ok(Some(raw)) => match raw.parse::<u64>() {
            Ok(n) if n >= 1 => n,
            _ => {
                eprintln!("invalid --heartbeat-secs value: {raw}");
                return ExitCode::from(2);
            }
        },
        Ok(None) => 25,
        Err(msg) => {
            eprintln!("{msg}");
            return ExitCode::from(2);
        }
    };
    let expected_fingerprint = match take_flag(args, "--expect-fingerprint") {
        Ok(val) => val,
        Err(msg) => {
            eprintln!("{msg}");
            return ExitCode::from(2);
        }
    };
    let stop_on_mismatch = has_flag(args, "--stop-on-mismatch");

    let mut cfg = DaemonConfig::new(hub_url);
    cfg.state_dir = state_dir;
    cfg.transport_mode = transport_mode;
    cfg.heartbeat_interval = Duration::from_secs(heartbeat_secs);
    cfg.expected_fingerprint = expected_fingerprint;
    cfg.stop_on_fingerprint_mismatch = stop_on_mismatch;

    let supervisor = match DaemonSupervisor::new(cfg) {
        Ok(sup) => sup,
        Err(err) => {
            eprintln!("failed to initialize daemon: {err}");
            return ExitCode::FAILURE;
        }
    };

    let mut events = supervisor.subscribe_events();
    let mut handle = supervisor.start();
    let mut mismatch_hit = false;

    let event_logger = tokio::spawn(async move {
        let mut saw_mismatch = false;
        while let Ok(ev) = events.recv().await {
            if matches!(
                ev,
                DaemonEvent::AwaitingFingerprint(_)
                    | DaemonEvent::StateChanged(DaemonState::AwaitingFingerprint(_))
                    | DaemonEvent::StateChanged(DaemonState::Error { .. })
            ) {
                saw_mismatch = true;
            }
            if let Ok(line) = serde_json::to_string(&ev) {
                println!("{line}");
            }
        }
        saw_mismatch
    });

    tokio::select! {
        _ = wait_shutdown_signal() => {
            supervisor.stop();
            let _ = (&mut handle).await;
        }
        _ = &mut handle => {}
    }
    drop(supervisor);

    if let Ok(saw) = event_logger.await {
        mismatch_hit = saw;
    }
    if mismatch_hit && stop_on_mismatch {
        ExitCode::from(3)
    } else {
        ExitCode::SUCCESS
    }
}

async fn wait_shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        if let Ok(mut term) = signal(SignalKind::terminate()) {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = term.recv() => {}
            }
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}
