//! Port of `scripts/codex-app-launcher.js` — installs/removes the Codex app
//! launcher routing (`codex-multi-auth-app-launcher` binary, ARCHITECTURE §2).
//!
//! Windows: retargets existing user-level `Codex.lnk` shortcuts (Start Menu,
//! taskbar pins, desktops) through codex-multi-auth via a generated PowerShell
//! script, backing originals up to `<mad>/app-shortcuts.json`. macOS: creates
//! a managed `Codex Multi Auth.app` bundle. Linux: a managed `.desktop` file.
//! `--dry-run` prints planned changes; `--remove` restores/removes.
//!
//! R3 adaptation: the TS plan launched `node scripts/codex.js app`; the Rust
//! plan launches the wrapper binary `codex-multi-auth-codex app` directly
//! (`command_path` = wrapper binary, `command_argv` drops the script path).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use cma_core::fs_retry::with_file_operation_retry;
use serde_json::Value;

pub const OFFICIAL_LAUNCHER_NAME: &str = "Codex";
pub const MANAGED_LAUNCHER_NAME: &str = "Codex Multi Auth";
const WINDOWS_SHORTCUT_NAME: &str = "Codex.lnk";
const LINUX_DESKTOP_FILE_NAME: &str = "codex-multi-auth.desktop";
const MACOS_APP_NAME: &str = "Codex Multi Auth.app";
const WINDOWS_BACKUP_FILE_NAME: &str = "app-shortcuts.json";
const MANAGED_SHORTCUT_DESCRIPTION: &str =
    "Launch Codex through codex-multi-auth runtime rotation";
/// The wrapper binary the launcher routes through (R3).
pub const CODEX_WRAPPER_BIN_NAME: &str = "codex-multi-auth-codex";

pub type EnvMap = HashMap<String, String>;
/// A shared `(message) -> ()` sink (TS `log?: (message: string) => void`).
pub type SharedLogSink = Arc<dyn Fn(&str) + Send + Sync>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppLauncherMode {
    RouteExisting,
    CreateManaged,
}

impl AppLauncherMode {
    pub fn as_str(self) -> &'static str {
        match self {
            AppLauncherMode::RouteExisting => "route-existing",
            AppLauncherMode::CreateManaged => "create-managed",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct AppLauncherPlan {
    pub platform: String,
    pub mode: AppLauncherMode,
    pub launcher_path: PathBuf,
    /// win32 only: shortcut roots scanned for `Codex.lnk`.
    pub shortcut_roots: Vec<PathBuf>,
    /// win32 only: original-shortcut backup file.
    pub backup_path: Option<PathBuf>,
    pub command_path: PathBuf,
    pub command_args: String,
    pub command_argv: Vec<String>,
    pub working_directory: PathBuf,
    pub icon_path: String,
}

#[derive(Default)]
pub struct AppLauncherOptions {
    pub env: Option<EnvMap>,
    pub platform: Option<String>,
    pub home: Option<PathBuf>,
    /// Wrapper binary override (tests / non-standard layouts).
    pub codex_bin_path: Option<PathBuf>,
    pub dry_run: bool,
    pub remove: bool,
    pub log: Option<SharedLogSink>,
}

impl AppLauncherOptions {
    fn env_var(&self, key: &str) -> Option<String> {
        match &self.env {
            Some(map) => map.get(key).cloned(),
            None => std::env::var(key).ok(),
        }
    }

    fn env_var_non_blank(&self, key: &str) -> Option<String> {
        self.env_var(key)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    }

    fn log(&self, message: &str) {
        match &self.log {
            Some(log) => log(message),
            None => println!("{message}"),
        }
    }
}

// ---------------------------------------------------------------------------
// Quoting helpers (verbatim ports)
// ---------------------------------------------------------------------------

fn quote_powershell_single(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn quote_powershell_boolean(value: bool) -> &'static str {
    if value { "$true" } else { "$false" }
}

fn quote_powershell_array(values: &[String]) -> String {
    if values.is_empty() {
        return "@()".to_string();
    }
    format!(
        "@({})",
        values
            .iter()
            .map(|value| quote_powershell_single(value))
            .collect::<Vec<_>>()
            .join(", ")
    )
}

fn quote_desktop_exec(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn quote_posix_shell(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn unique_strings(values: Vec<String>) -> Vec<String> {
    let mut seen = Vec::new();
    for value in values {
        if value.trim().is_empty() {
            continue;
        }
        if !seen.contains(&value) {
            seen.push(value);
        }
    }
    seen
}

/// Base64 (standard alphabet, padded) of the UTF-16LE encoding — PowerShell
/// `-EncodedCommand` transport. Hand-rolled: `base64` is not a cma-runtime
/// dependency.
fn encode_powershell_command(value: &str) -> String {
    let mut bytes = Vec::with_capacity(value.len() * 2);
    for unit in value.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    base64_encode(&bytes)
}

fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[(triple >> 18) as usize & 0x3f] as char);
        out.push(ALPHABET[(triple >> 12) as usize & 0x3f] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(triple >> 6) as usize & 0x3f] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[triple as usize & 0x3f] as char
        } else {
            '='
        });
    }
    out
}

// ---------------------------------------------------------------------------
// Directory resolution
// ---------------------------------------------------------------------------

fn resolve_app_data(options: &AppLauncherOptions, home: &Path) -> PathBuf {
    options
        .env_var_non_blank("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join("AppData").join("Roaming"))
}

fn resolve_windows_start_menu_dir(options: &AppLauncherOptions, home: &Path) -> PathBuf {
    resolve_app_data(options, home)
        .join("Microsoft")
        .join("Windows")
        .join("Start Menu")
        .join("Programs")
}

fn resolve_windows_powershell_path(options: &AppLauncherOptions) -> PathBuf {
    let system_root = options
        .env_var_non_blank("SystemRoot")
        .or_else(|| options.env_var_non_blank("SYSTEMROOT"))
        .unwrap_or_else(|| "C:\\Windows".to_string());
    PathBuf::from(system_root)
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe")
}

fn resolve_windows_taskbar_pinned_dir(options: &AppLauncherOptions, home: &Path) -> PathBuf {
    resolve_app_data(options, home)
        .join("Microsoft")
        .join("Internet Explorer")
        .join("Quick Launch")
        .join("User Pinned")
        .join("TaskBar")
}

fn resolve_windows_desktop_dirs(options: &AppLauncherOptions, home: &Path) -> Vec<String> {
    let configured = options
        .env_var("CODEX_MULTI_AUTH_APP_LAUNCHER_WINDOWS_DESKTOP_DIR")
        .map(|value| value.trim().to_string())
        .unwrap_or_default();
    let mut values = vec![configured];
    for key in ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"] {
        if let Some(root) = options.env_var_non_blank(key) {
            values.push(PathBuf::from(root).join("Desktop").to_string_lossy().into_owned());
        }
    }
    values.push(home.join("Desktop").to_string_lossy().into_owned());
    unique_strings(values)
}

fn resolve_codex_multi_auth_dir(options: &AppLauncherOptions, home: &Path) -> PathBuf {
    options
        .env_var_non_blank("CODEX_MULTI_AUTH_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".codex").join("multi-auth"))
}

fn resolve_linux_applications_dir(options: &AppLauncherOptions, home: &Path) -> PathBuf {
    options
        .env_var_non_blank("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".local").join("share"))
        .join("applications")
}

fn resolve_mac_applications_dir(options: &AppLauncherOptions, home: &Path) -> PathBuf {
    options
        .env_var_non_blank("CODEX_MULTI_AUTH_APP_LAUNCHER_MACOS_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join("Applications"))
}

fn default_home(options: &AppLauncherOptions) -> PathBuf {
    let non_blank = |key: &str| options.env_var_non_blank(key).map(PathBuf::from);
    if cfg!(windows) {
        non_blank("USERPROFILE")
            .or_else(|| non_blank("HOME"))
            .unwrap_or_else(|| PathBuf::from("."))
    } else {
        non_blank("HOME").unwrap_or_else(|| PathBuf::from("."))
    }
}

/// Resolve the `codex-multi-auth-codex` wrapper binary (R3): override wins,
/// else the sibling of the current executable. Existence is not required for
/// plan building (dry runs print the target either way).
fn resolve_codex_wrapper_bin(options: &AppLauncherOptions) -> PathBuf {
    if let Some(override_path) = &options.codex_bin_path {
        return override_path.clone();
    }
    let bin_name = format!("{CODEX_WRAPPER_BIN_NAME}{}", std::env::consts::EXE_SUFFIX);
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join(&bin_name)))
        .unwrap_or_else(|| PathBuf::from(bin_name))
}

/// `resolveAppLauncherPlan` — pure plan builder.
pub fn resolve_app_launcher_plan(options: &AppLauncherOptions) -> AppLauncherPlan {
    let platform = options
        .platform
        .clone()
        .unwrap_or_else(|| crate::app_bind::current_platform().to_string());
    let home = options.home.clone().unwrap_or_else(|| default_home(options));
    let wrapper_bin = resolve_codex_wrapper_bin(options);
    let wrapper_bin_str = wrapper_bin.to_string_lossy().into_owned();

    if platform == "win32" {
        let start_menu_dir = resolve_windows_start_menu_dir(options, &home);
        let command = [
            "$ErrorActionPreference = 'Stop'".to_string(),
            format!(
                "Set-Location -LiteralPath {}",
                quote_powershell_single(&home.to_string_lossy())
            ),
            format!("& {} app", quote_powershell_single(&wrapper_bin_str)),
        ]
        .join("; ");
        let mut shortcut_roots = vec![
            start_menu_dir.clone(),
            resolve_windows_taskbar_pinned_dir(options, &home),
        ];
        shortcut_roots.extend(
            resolve_windows_desktop_dirs(options, &home)
                .into_iter()
                .map(PathBuf::from),
        );
        return AppLauncherPlan {
            platform,
            mode: AppLauncherMode::RouteExisting,
            launcher_path: start_menu_dir.join(WINDOWS_SHORTCUT_NAME),
            shortcut_roots,
            backup_path: Some(
                resolve_codex_multi_auth_dir(options, &home).join(WINDOWS_BACKUP_FILE_NAME),
            ),
            command_path: resolve_windows_powershell_path(options),
            command_args: format!(
                "-NoProfile -ExecutionPolicy Bypass -EncodedCommand {}",
                encode_powershell_command(&command)
            ),
            command_argv: vec!["app".to_string()],
            working_directory: home,
            icon_path: wrapper_bin_str,
        };
    }

    if platform == "darwin" {
        let app_path = resolve_mac_applications_dir(options, &home).join(MACOS_APP_NAME);
        return AppLauncherPlan {
            platform,
            mode: AppLauncherMode::CreateManaged,
            launcher_path: app_path,
            shortcut_roots: Vec::new(),
            backup_path: None,
            command_path: wrapper_bin,
            command_args: "app".to_string(),
            command_argv: vec!["app".to_string()],
            working_directory: home,
            icon_path: wrapper_bin_str,
        };
    }

    let desktop_path = resolve_linux_applications_dir(options, &home).join(LINUX_DESKTOP_FILE_NAME);
    AppLauncherPlan {
        platform,
        mode: AppLauncherMode::CreateManaged,
        launcher_path: desktop_path,
        shortcut_roots: Vec::new(),
        backup_path: None,
        command_path: wrapper_bin,
        command_args: "app %F".to_string(),
        command_argv: vec!["app".to_string(), "%F".to_string()],
        working_directory: home,
        icon_path: "utilities-terminal".to_string(),
    }
}

// ---------------------------------------------------------------------------
// Windows PowerShell script (verbatim port with R3 target)
// ---------------------------------------------------------------------------

/// `createWindowsShortcutPowerShellScript` — builds the routing (or restore)
/// script run through `powershell.exe`. Emits a single compressed JSON result
/// line consumed by [`install_codex_app_launcher`].
pub fn create_windows_shortcut_powershell_script(
    plan: &AppLauncherPlan,
    dry_run: bool,
    remove: bool,
) -> String {
    let shortcut_roots: Vec<String> = plan
        .shortcut_roots
        .iter()
        .map(|root| root.to_string_lossy().into_owned())
        .collect();
    let backup_path = plan
        .backup_path
        .as_ref()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default();

    if remove {
        return [
            "$ErrorActionPreference = 'Stop'".to_string(),
            format!("$DryRun = {}", quote_powershell_boolean(dry_run)),
            format!("$BackupPath = {}", quote_powershell_single(&backup_path)),
            "$Restored = @()".to_string(),
            "$Skipped = @()".to_string(),
            "if (Test-Path -LiteralPath $BackupPath) {".to_string(),
            "  $Raw = Get-Content -LiteralPath $BackupPath -Raw -Encoding UTF8".to_string(),
            "  $Backups = @($Raw | ConvertFrom-Json)".to_string(),
            "  $Shell = New-Object -ComObject WScript.Shell".to_string(),
            "  foreach ($Backup in $Backups) {".to_string(),
            "    if ($null -eq $Backup.Path -or -not (Test-Path -LiteralPath $Backup.Path)) {"
                .to_string(),
            "      if ($null -ne $Backup.Path) { $Skipped += [string]$Backup.Path }".to_string(),
            "      continue".to_string(),
            "    }".to_string(),
            "    if (-not $DryRun) {".to_string(),
            "      $Shortcut = $Shell.CreateShortcut([string]$Backup.Path)".to_string(),
            "      $Shortcut.TargetPath = [string]$Backup.TargetPath".to_string(),
            "      $Shortcut.Arguments = [string]$Backup.Arguments".to_string(),
            "      $Shortcut.WorkingDirectory = [string]$Backup.WorkingDirectory".to_string(),
            "      $Shortcut.IconLocation = [string]$Backup.IconLocation".to_string(),
            "      $Shortcut.Description = [string]$Backup.Description".to_string(),
            "      $Shortcut.Save()".to_string(),
            "    }".to_string(),
            "    $Restored += [string]$Backup.Path".to_string(),
            "  }".to_string(),
            "  if (-not $DryRun) { Remove-Item -LiteralPath $BackupPath -Force -ErrorAction SilentlyContinue }"
                .to_string(),
            "}".to_string(),
            "$Result = [ordered]@{ action = 'restore'; dryRun = $DryRun; backupPath = $BackupPath; restored = @($Restored); skipped = @($Skipped) }"
                .to_string(),
            "$Result | ConvertTo-Json -Depth 6 -Compress".to_string(),
        ]
        .join("\r\n");
    }

    [
        "$ErrorActionPreference = 'Stop'".to_string(),
        format!("$DryRun = {}", quote_powershell_boolean(dry_run)),
        format!("$ShortcutRoots = {}", quote_powershell_array(&shortcut_roots)),
        "$ShellDesktop = [Environment]::GetFolderPath('Desktop')".to_string(),
        "if (-not [string]::IsNullOrWhiteSpace($ShellDesktop)) { $ShortcutRoots = @($ShortcutRoots + $ShellDesktop) | Sort-Object -Unique }"
            .to_string(),
        format!("$BackupPath = {}", quote_powershell_single(&backup_path)),
        format!(
            "$ShortcutName = {}",
            quote_powershell_single(OFFICIAL_LAUNCHER_NAME)
        ),
        format!(
            "$TargetPath = {}",
            quote_powershell_single(&plan.command_path.to_string_lossy())
        ),
        format!("$Arguments = {}", quote_powershell_single(&plan.command_args)),
        format!(
            "$WorkingDirectory = {}",
            quote_powershell_single(&plan.working_directory.to_string_lossy())
        ),
        format!(
            "$ManagedDescription = {}",
            quote_powershell_single(MANAGED_SHORTCUT_DESCRIPTION)
        ),
        "$Candidates = @()".to_string(),
        "$PackagedApps = @()".to_string(),
        "foreach ($Root in $ShortcutRoots) {".to_string(),
        "  if (-not (Test-Path -LiteralPath $Root)) { continue }".to_string(),
        "  $Candidates += Get-ChildItem -LiteralPath $Root -Filter '*.lnk' -File -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.BaseName -ieq $ShortcutName } | ForEach-Object { $_.FullName }"
            .to_string(),
        "}".to_string(),
        "$Candidates = @($Candidates | Sort-Object -Unique)".to_string(),
        "try {".to_string(),
        "  $AppsFolder = (New-Object -ComObject Shell.Application).Namespace('shell:AppsFolder')"
            .to_string(),
        "  if ($null -ne $AppsFolder) {".to_string(),
        "    $PackagedApps = @($AppsFolder.Items() | Where-Object { $_.Name -ieq $ShortcutName } | ForEach-Object { [ordered]@{ Name = [string]$_.Name; Path = [string]$_.Path } })"
            .to_string(),
        "  }".to_string(),
        "} catch { $PackagedApps = @() }".to_string(),
        "$Shell = New-Object -ComObject WScript.Shell".to_string(),
        "$ExistingBackups = @()".to_string(),
        "if (Test-Path -LiteralPath $BackupPath) {".to_string(),
        "  try {".to_string(),
        "    $Raw = Get-Content -LiteralPath $BackupPath -Raw -Encoding UTF8".to_string(),
        "    if ($Raw.Trim().Length -gt 0) { $ExistingBackups = @($Raw | ConvertFrom-Json) }"
            .to_string(),
        "  } catch { $ExistingBackups = @() }".to_string(),
        "}".to_string(),
        "$BackupByPath = @{}".to_string(),
        "$BackupsToWrite = New-Object System.Collections.ArrayList".to_string(),
        "foreach ($Backup in $ExistingBackups) {".to_string(),
        "  if ($null -eq $Backup.Path) { continue }".to_string(),
        "  $BackupByPath[[string]$Backup.Path] = $Backup".to_string(),
        "  [void]$BackupsToWrite.Add($Backup)".to_string(),
        "}".to_string(),
        "$Routed = @()".to_string(),
        "$Skipped = @()".to_string(),
        "foreach ($Path in $Candidates) {".to_string(),
        "  $Shortcut = $Shell.CreateShortcut($Path)".to_string(),
        "  $ShortcutText = (($Shortcut.TargetPath, $Shortcut.Arguments, $Shortcut.Description) -join ' ')"
            .to_string(),
        "  if ($ShortcutText -notmatch '(?i)codex') {".to_string(),
        "    $Skipped += $Path".to_string(),
        "    continue".to_string(),
        "  }".to_string(),
        "  $AlreadyManaged = (([string]$Shortcut.Description) -eq $ManagedDescription) -or ((([string]$Shortcut.TargetPath) -ieq $TargetPath) -and (([string]$Shortcut.Arguments) -ieq $Arguments))"
            .to_string(),
        "  if (-not $BackupByPath.ContainsKey($Path) -and -not $AlreadyManaged) {".to_string(),
        "    $IconLocation = [string]$Shortcut.IconLocation".to_string(),
        "    if ([string]::IsNullOrWhiteSpace($IconLocation)) { $IconLocation = [string]$Shortcut.TargetPath }"
            .to_string(),
        "    $Backup = [ordered]@{".to_string(),
        "      Path = [string]$Path".to_string(),
        "      TargetPath = [string]$Shortcut.TargetPath".to_string(),
        "      Arguments = [string]$Shortcut.Arguments".to_string(),
        "      WorkingDirectory = [string]$Shortcut.WorkingDirectory".to_string(),
        "      IconLocation = $IconLocation".to_string(),
        "      Description = [string]$Shortcut.Description".to_string(),
        "    }".to_string(),
        "    [void]$BackupsToWrite.Add($Backup)".to_string(),
        "    $BackupByPath[$Path] = $Backup".to_string(),
        "  }".to_string(),
        "  if (-not $DryRun) {".to_string(),
        "    $Backup = $BackupByPath[$Path]".to_string(),
        "    $Shortcut.TargetPath = $TargetPath".to_string(),
        "    $Shortcut.Arguments = $Arguments".to_string(),
        "    $Shortcut.WorkingDirectory = $WorkingDirectory".to_string(),
        "    if ($null -ne $Backup -and $null -ne $Backup.IconLocation) { $Shortcut.IconLocation = [string]$Backup.IconLocation }"
            .to_string(),
        "    $Shortcut.Description = $ManagedDescription".to_string(),
        "    $Shortcut.Save()".to_string(),
        "  }".to_string(),
        "  $Routed += $Path".to_string(),
        "}".to_string(),
        "if (-not $DryRun -and $Routed.Count -gt 0) {".to_string(),
        "  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $BackupPath) | Out-Null"
            .to_string(),
        "  @($BackupsToWrite) | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $BackupPath -Encoding UTF8"
            .to_string(),
        "}".to_string(),
        "$Result = [ordered]@{ action = 'route'; dryRun = $DryRun; backupPath = $BackupPath; candidates = @($Candidates); packagedApps = @($PackagedApps); routed = @($Routed); skipped = @($Skipped); targetPath = $TargetPath; arguments = $Arguments }"
            .to_string(),
        "$Result | ConvertTo-Json -Depth 6 -Compress".to_string(),
    ]
    .join("\r\n")
}

// ---------------------------------------------------------------------------
// Managed launcher file contents (Linux / macOS)
// ---------------------------------------------------------------------------

fn create_linux_desktop_file(plan: &AppLauncherPlan) -> String {
    [
        "[Desktop Entry]".to_string(),
        "Type=Application".to_string(),
        format!("Name={MANAGED_LAUNCHER_NAME}"),
        "Comment=Launch Codex through codex-multi-auth runtime rotation".to_string(),
        format!(
            "Exec={} {}",
            quote_desktop_exec(&plan.command_path.to_string_lossy()),
            plan.command_args
        ),
        format!("Path={}", plan.working_directory.to_string_lossy()),
        format!("Icon={}", plan.icon_path),
        "Terminal=false".to_string(),
        "Categories=Development;".to_string(),
        "StartupNotify=true".to_string(),
        String::new(),
    ]
    .join("\n")
}

fn create_mac_info_plist() -> String {
    [
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
        "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
        "<plist version=\"1.0\">",
        "<dict>",
        "  <key>CFBundleExecutable</key>",
        "  <string>Codex</string>",
        "  <key>CFBundleIdentifier</key>",
        "  <string>com.ndycode.codex-multi-auth.launcher</string>",
        "  <key>CFBundleName</key>",
        &format!("  <string>{MANAGED_LAUNCHER_NAME}</string>"),
        "  <key>CFBundlePackageType</key>",
        "  <string>APPL</string>",
        "</dict>",
        "</plist>",
        "",
    ]
    .join("\n")
}

fn create_mac_launcher_script(plan: &AppLauncherPlan) -> String {
    let args = plan
        .command_argv
        .iter()
        .map(|arg| quote_posix_shell(arg))
        .collect::<Vec<_>>()
        .join(" ");
    [
        "#!/bin/sh".to_string(),
        format!(
            "cd {}",
            quote_posix_shell(&plan.working_directory.to_string_lossy())
        ),
        format!(
            "exec {} {}",
            quote_posix_shell(&plan.command_path.to_string_lossy()),
            args
        ),
        String::new(),
    ]
    .join("\n")
}

// ---------------------------------------------------------------------------
// Install / remove
// ---------------------------------------------------------------------------

async fn write_text_file_with_retry(path: &Path, content: &str) -> Result<(), String> {
    with_file_operation_retry(|| async {
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::write(path, content).await
    })
    .await
    .map_err(|error: std::io::Error| error.to_string())
}

#[cfg(unix)]
fn chmod_755(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
        .map_err(|error| error.to_string())
}

#[cfg(not(unix))]
fn chmod_755(_path: &Path) -> Result<(), String> {
    Ok(())
}

async fn install_linux_desktop_file(plan: &AppLauncherPlan) -> Result<(), String> {
    write_text_file_with_retry(&plan.launcher_path, &create_linux_desktop_file(plan)).await?;
    chmod_755(&plan.launcher_path)
}

async fn install_mac_app_bundle(plan: &AppLauncherPlan) -> Result<(), String> {
    let contents_dir = plan.launcher_path.join("Contents");
    let macos_dir = contents_dir.join("MacOS");
    tokio::fs::create_dir_all(&macos_dir)
        .await
        .map_err(|error| error.to_string())?;
    write_text_file_with_retry(&contents_dir.join("Info.plist"), &create_mac_info_plist()).await?;
    let launcher_script_path = macos_dir.join("Codex");
    write_text_file_with_retry(&launcher_script_path, &create_mac_launcher_script(plan)).await?;
    chmod_755(&launcher_script_path)
}

/// `rm -rf` analogue (force: missing paths are fine; recursive for the .app
/// bundle), wrapped in the shared transient-error retry.
async fn remove_path_recursive(path: &Path) -> Result<(), String> {
    with_file_operation_retry(|| async {
        match tokio::fs::metadata(path).await {
            Ok(metadata) if metadata.is_dir() => tokio::fs::remove_dir_all(path).await,
            Ok(_) => tokio::fs::remove_file(path).await,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        }
    })
    .await
    .map_err(|error: std::io::Error| error.to_string())
}

async fn run_powershell(
    powershell: &Path,
    script: &str,
    env: Option<&EnvMap>,
) -> Result<(String, String), String> {
    let mut command = tokio::process::Command::new(powershell);
    command.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script]);
    if let Some(env) = env {
        command.envs(env.iter());
    }
    command.stdin(std::process::Stdio::null());
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let output = command
        .output()
        .await
        .map_err(|error| error.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    if !output.status.success() {
        let code = output
            .status
            .code()
            .map(|code| code.to_string())
            .unwrap_or_else(|| "unknown".to_string());
        return Err(format!(
            "{} exited with {code}: {}",
            powershell.to_string_lossy(),
            stderr.trim()
        ));
    }
    Ok((stdout, stderr))
}

async fn install_windows_shortcut(
    plan: &AppLauncherPlan,
    options: &AppLauncherOptions,
) -> Result<Value, String> {
    let script = create_windows_shortcut_powershell_script(plan, options.dry_run, options.remove);
    let powershell = resolve_windows_powershell_path(options);
    let (stdout, _stderr) = run_powershell(&powershell, &script, options.env.as_ref()).await?;
    let output = stdout
        .trim()
        .split(['\r', '\n'])
        .rfind(|line| !line.is_empty());
    let Some(output) = output else {
        return Ok(serde_json::json!({
            "action": if options.remove { "restore" } else { "route" },
            "routed": [],
            "restored": [],
            "skipped": [],
        }));
    };
    serde_json::from_str::<Value>(output).map_err(|error| {
        let tail: String = {
            let trimmed = stdout.trim();
            let chars: Vec<char> = trimmed.chars().collect();
            let start = chars.len().saturating_sub(512);
            chars[start..].iter().collect()
        };
        format!("codex-multi-auth-app-launcher: unexpected powershell output ({error}): {tail}")
    })
}

fn array_len(result: &Value, key: &str) -> usize {
    result
        .get(key)
        .and_then(Value::as_array)
        .map(|values| values.len())
        .unwrap_or(0)
}

/// `installCodexAppLauncher` — routes/installs (or removes/restores) the
/// launcher per the plan; logs the frozen user-visible messages; returns the
/// plan.
pub async fn install_codex_app_launcher(
    options: &AppLauncherOptions,
) -> Result<AppLauncherPlan, String> {
    let plan = resolve_app_launcher_plan(options);

    if plan.platform == "win32" {
        let result = install_windows_shortcut(&plan, options).await?;
        let routed_count = array_len(&result, "routed");
        let restored_count = array_len(&result, "restored");
        let packaged_app_count = array_len(&result, "packagedApps");
        if options.remove {
            let prefix = if options.dry_run {
                "[dry-run] Would restore"
            } else {
                "Restored"
            };
            options.log(&format!(
                "{prefix} {restored_count} Codex app shortcut(s) from {}",
                plan.backup_path
                    .as_ref()
                    .map(|path| path.to_string_lossy().into_owned())
                    .unwrap_or_default()
            ));
            return Ok(plan);
        }
        if routed_count == 0 {
            let prefix = if options.dry_run { "[dry-run] No" } else { "No" };
            options.log(&format!(
                "{prefix} existing Codex app shortcuts or taskbar pins found to route through codex-multi-auth."
            ));
            if packaged_app_count > 0 {
                options.log(&format!(
                    "Detected {packaged_app_count} packaged Codex app entry; packaged app entries cannot be retargeted without a persistent background router."
                ));
            }
            return Ok(plan);
        }
        let prefix = if options.dry_run {
            "[dry-run] Would route"
        } else {
            "Routed"
        };
        options.log(&format!(
            "{prefix} {routed_count} existing Codex app shortcut(s) through codex-multi-auth"
        ));
        if options.dry_run {
            options.log(&format!(
                "[dry-run] Target: {} {}",
                plan.command_path.to_string_lossy(),
                plan.command_args
            ));
        }
        return Ok(plan);
    }

    if options.remove {
        if options.dry_run {
            options.log(&format!(
                "[dry-run] Would remove {}",
                plan.launcher_path.to_string_lossy()
            ));
            return Ok(plan);
        }
        remove_path_recursive(&plan.launcher_path).await?;
        options.log(&format!(
            "Removed {MANAGED_LAUNCHER_NAME} app launcher: {}",
            plan.launcher_path.to_string_lossy()
        ));
        return Ok(plan);
    }

    if options.dry_run {
        options.log(&format!(
            "[dry-run] Would install {MANAGED_LAUNCHER_NAME} app launcher: {}",
            plan.launcher_path.to_string_lossy()
        ));
        options.log(&format!(
            "[dry-run] Target: {} {}",
            plan.command_path.to_string_lossy(),
            plan.command_args
        ));
        return Ok(plan);
    }

    if plan.platform == "darwin" {
        install_mac_app_bundle(&plan).await?;
    } else {
        install_linux_desktop_file(&plan).await?;
    }
    options.log(&format!(
        "Installed {MANAGED_LAUNCHER_NAME} app launcher: {}",
        plan.launcher_path.to_string_lossy()
    ));
    Ok(plan)
}

fn print_help() {
    println!(
        "{}",
        [
            "Usage: codex-multi-auth-app-launcher [--remove] [--dry-run]",
            "",
            "Routes existing user-level Codex app shortcuts through codex-multi-auth on Windows.",
            &format!(
                "On other platforms, installs a user-level {MANAGED_LAUNCHER_NAME} app launcher that runs `codex app` through codex-multi-auth."
            ),
            "",
            "Options:",
            "  --remove   Remove the managed launcher",
            "  --dry-run  Print planned changes without writing",
            "  --help     Show this help",
            "",
        ]
        .join("\n")
    );
}

/// Binary entry (`codex-multi-auth-app-launcher`, ARCHITECTURE §2): `--help`
/// prints usage; otherwise install/remove with `--dry-run`/`--remove`. Errors
/// print `Codex app launcher routing failed: <message>` to stderr, exit 1.
pub async fn run(args: &[String]) -> i32 {
    let arg_set: std::collections::HashSet<&str> =
        args.iter().map(String::as_str).collect();
    if arg_set.contains("--help") || arg_set.contains("-h") {
        print_help();
        return 0;
    }
    let options = AppLauncherOptions {
        dry_run: arg_set.contains("--dry-run"),
        remove: arg_set.contains("--remove"),
        ..AppLauncherOptions::default()
    };
    match install_codex_app_launcher(&options).await {
        Ok(_) => 0,
        Err(error) => {
            eprintln!("Codex app launcher routing failed: {error}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env_of(pairs: &[(&str, &str)]) -> EnvMap {
        pairs
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect()
    }

    fn options(platform: &str, home: &Path, env: EnvMap) -> AppLauncherOptions {
        AppLauncherOptions {
            env: Some(env),
            platform: Some(platform.to_string()),
            home: Some(home.to_path_buf()),
            codex_bin_path: Some(home.join("bin").join("codex-multi-auth-codex")),
            ..AppLauncherOptions::default()
        }
    }

    #[test]
    fn base64_utf16le_encoding_matches_node_buffer_output() {
        // Buffer.from("ab", "utf16le").toString("base64") === "YQBiAA=="
        assert_eq!(encode_powershell_command("ab"), "YQBiAA==");
        // Buffer.from("$x = 1", "utf16le").toString("base64")
        assert_eq!(encode_powershell_command("$x = 1"), "JAB4ACAAPQAgADEA");
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
    }

    #[test]
    fn quoting_helpers_match_js() {
        assert_eq!(quote_powershell_single("a'b"), "'a''b'");
        assert_eq!(quote_powershell_boolean(true), "$true");
        assert_eq!(quote_powershell_array(&[]), "@()");
        assert_eq!(
            quote_powershell_array(&["a".to_string(), "b'c".to_string()]),
            "@('a', 'b''c')"
        );
        assert_eq!(quote_desktop_exec("C:\\x \"y\""), "\"C:\\\\x \\\"y\\\"\"");
        assert_eq!(quote_posix_shell("a'b"), "'a'\\''b'");
    }

    #[test]
    fn resolves_windows_route_existing_plan() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let app_data = home.join("Roaming");
        let env = env_of(&[
            ("APPDATA", &app_data.to_string_lossy()),
            ("CODEX_MULTI_AUTH_DIR", &home.join("mad").to_string_lossy()),
            ("OneDrive", &home.join("OneDrive").to_string_lossy()),
            ("SystemRoot", "C:\\Windows"),
        ]);
        let plan = resolve_app_launcher_plan(&options("win32", home, env));
        assert_eq!(plan.mode, AppLauncherMode::RouteExisting);
        let start_menu = app_data
            .join("Microsoft")
            .join("Windows")
            .join("Start Menu")
            .join("Programs");
        assert_eq!(plan.launcher_path, start_menu.join("Codex.lnk"));
        assert_eq!(
            plan.backup_path,
            Some(home.join("mad").join(WINDOWS_BACKUP_FILE_NAME))
        );
        // Roots: start menu, taskbar pins, OneDrive desktop, home desktop.
        assert_eq!(plan.shortcut_roots[0], start_menu);
        assert!(plan
            .shortcut_roots
            .iter()
            .any(|root| root.ends_with("TaskBar")));
        assert!(plan
            .shortcut_roots
            .contains(&home.join("OneDrive").join("Desktop")));
        assert!(plan.shortcut_roots.contains(&home.join("Desktop")));
        assert_eq!(
            plan.command_path,
            PathBuf::from("C:\\Windows")
                .join("System32")
                .join("WindowsPowerShell")
                .join("v1.0")
                .join("powershell.exe")
        );
        assert!(plan
            .command_args
            .starts_with("-NoProfile -ExecutionPolicy Bypass -EncodedCommand "));
        assert_eq!(plan.command_argv, vec!["app".to_string()]);
        assert_eq!(plan.working_directory, home);
    }

    #[test]
    fn resolves_linux_and_mac_create_managed_plans() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let wrapper = home.join("bin").join("codex-multi-auth-codex");

        let linux_plan = resolve_app_launcher_plan(&options("linux", home, EnvMap::new()));
        assert_eq!(linux_plan.mode, AppLauncherMode::CreateManaged);
        assert_eq!(
            linux_plan.launcher_path,
            home.join(".local")
                .join("share")
                .join("applications")
                .join(LINUX_DESKTOP_FILE_NAME)
        );
        assert_eq!(linux_plan.command_path, wrapper);
        assert_eq!(linux_plan.command_args, "app %F");
        assert_eq!(
            linux_plan.command_argv,
            vec!["app".to_string(), "%F".to_string()]
        );
        assert_eq!(linux_plan.icon_path, "utilities-terminal");

        let xdg = env_of(&[("XDG_DATA_HOME", &home.join("xdg").to_string_lossy())]);
        let xdg_plan = resolve_app_launcher_plan(&options("linux", home, xdg));
        assert_eq!(
            xdg_plan.launcher_path,
            home.join("xdg").join("applications").join(LINUX_DESKTOP_FILE_NAME)
        );

        let mac_plan = resolve_app_launcher_plan(&options("darwin", home, EnvMap::new()));
        assert_eq!(mac_plan.mode, AppLauncherMode::CreateManaged);
        assert_eq!(
            mac_plan.launcher_path,
            home.join("Applications").join(MACOS_APP_NAME)
        );
        assert_eq!(mac_plan.command_args, "app");
        let mac_dir = env_of(&[(
            "CODEX_MULTI_AUTH_APP_LAUNCHER_MACOS_DIR",
            &home.join("Custom").to_string_lossy(),
        )]);
        let custom_mac = resolve_app_launcher_plan(&options("darwin", home, mac_dir));
        assert_eq!(
            custom_mac.launcher_path,
            home.join("Custom").join(MACOS_APP_NAME)
        );
    }

    #[test]
    fn windows_powershell_script_contains_frozen_markers() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let env = env_of(&[("CODEX_MULTI_AUTH_DIR", &home.join("m'ad").to_string_lossy())]);
        let plan = resolve_app_launcher_plan(&options("win32", home, env));

        let route = create_windows_shortcut_powershell_script(&plan, true, false);
        assert!(route.starts_with("$ErrorActionPreference = 'Stop'\r\n$DryRun = $true"));
        assert!(route.contains("$ShortcutName = 'Codex'"));
        assert!(route.contains(
            "$ManagedDescription = 'Launch Codex through codex-multi-auth runtime rotation'"
        ));
        // Single-quote escaping in the backup path.
        assert!(route.contains("m''ad"));
        assert!(route.contains("ConvertTo-Json -Depth 6 -Compress"));
        assert!(route.contains("$Result = [ordered]@{ action = 'route';"));

        let restore = create_windows_shortcut_powershell_script(&plan, false, true);
        assert!(restore.contains("$DryRun = $false"));
        assert!(restore.contains("$Result = [ordered]@{ action = 'restore';"));
        assert!(restore.contains("Remove-Item -LiteralPath $BackupPath -Force"));
    }

    #[test]
    fn linux_desktop_file_and_mac_bundle_contents() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let wrapper = home.join("bin").join("codex-multi-auth-codex");
        let linux_plan = resolve_app_launcher_plan(&options("linux", home, EnvMap::new()));
        let desktop = create_linux_desktop_file(&linux_plan);
        assert!(desktop.starts_with("[Desktop Entry]\nType=Application\n"));
        assert!(desktop.contains("Name=Codex Multi Auth"));
        assert!(desktop.contains(&format!(
            "Exec={} app %F",
            quote_desktop_exec(&wrapper.to_string_lossy())
        )));
        assert!(desktop.contains("Terminal=false"));
        assert!(desktop.ends_with("StartupNotify=true\n"));

        let mac_plan = resolve_app_launcher_plan(&options("darwin", home, EnvMap::new()));
        let plist = create_mac_info_plist();
        assert!(plist.contains("<string>com.ndycode.codex-multi-auth.launcher</string>"));
        assert!(plist.contains("<string>Codex Multi Auth</string>"));
        assert!(plist.ends_with("</plist>\n"));
        let script = create_mac_launcher_script(&mac_plan);
        assert!(script.starts_with("#!/bin/sh\n"));
        assert!(script.contains(&format!(
            "exec {} 'app'",
            quote_posix_shell(&wrapper.to_string_lossy())
        )));
        assert!(script.ends_with("\n"));
    }

    #[tokio::test]
    async fn installs_and_removes_the_linux_desktop_launcher() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let logs: Arc<std::sync::Mutex<Vec<String>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let log_sink = {
            let logs = logs.clone();
            Arc::new(move |message: &str| {
                logs.lock().unwrap().push(message.to_string());
            })
        };
        let mut install_options = options("linux", home, EnvMap::new());
        install_options.log = Some(log_sink.clone());
        let plan = install_codex_app_launcher(&install_options)
            .await
            .expect("install succeeds");
        assert!(plan.launcher_path.exists());
        assert!(logs
            .lock()
            .unwrap()
            .iter()
            .any(|line| line
                == &format!(
                    "Installed Codex Multi Auth app launcher: {}",
                    plan.launcher_path.to_string_lossy()
                )));

        // Dry-run remove leaves the file and prints the plan.
        let mut dry_remove = options("linux", home, EnvMap::new());
        dry_remove.remove = true;
        dry_remove.dry_run = true;
        dry_remove.log = Some(log_sink.clone());
        install_codex_app_launcher(&dry_remove).await.unwrap();
        assert!(plan.launcher_path.exists());
        assert!(logs
            .lock()
            .unwrap()
            .iter()
            .any(|line| line.starts_with("[dry-run] Would remove ")));

        let mut remove_options = options("linux", home, EnvMap::new());
        remove_options.remove = true;
        remove_options.log = Some(log_sink);
        install_codex_app_launcher(&remove_options).await.unwrap();
        assert!(!plan.launcher_path.exists());
        assert!(logs
            .lock()
            .unwrap()
            .iter()
            .any(|line| line.starts_with("Removed Codex Multi Auth app launcher: ")));
    }

    #[tokio::test]
    async fn installs_the_mac_app_bundle_shape() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let mut install_options = options("darwin", home, EnvMap::new());
        install_options.log = Some(Arc::new(|_message: &str| {}));
        let plan = install_codex_app_launcher(&install_options)
            .await
            .expect("install succeeds");
        assert!(plan.launcher_path.join("Contents").join("Info.plist").exists());
        assert!(plan
            .launcher_path
            .join("Contents")
            .join("MacOS")
            .join("Codex")
            .exists());
        // Remove deletes the whole bundle directory.
        let mut remove_options = options("darwin", home, EnvMap::new());
        remove_options.remove = true;
        remove_options.log = Some(Arc::new(|_message: &str| {}));
        install_codex_app_launcher(&remove_options).await.unwrap();
        assert!(!plan.launcher_path.exists());
    }

    #[tokio::test]
    async fn dry_run_install_prints_target_without_writing() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let logs: Arc<std::sync::Mutex<Vec<String>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut dry = options("linux", home, EnvMap::new());
        dry.dry_run = true;
        dry.log = Some({
            let logs = logs.clone();
            Arc::new(move |message: &str| logs.lock().unwrap().push(message.to_string()))
        });
        let plan = install_codex_app_launcher(&dry).await.unwrap();
        assert!(!plan.launcher_path.exists());
        let logs = logs.lock().unwrap();
        assert!(logs
            .iter()
            .any(|line| line.starts_with("[dry-run] Would install Codex Multi Auth app launcher: ")));
        assert!(logs
            .iter()
            .any(|line| line.starts_with("[dry-run] Target: ")));
    }
}
