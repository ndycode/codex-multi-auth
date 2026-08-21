//! Port of `lib/codex-manager/commands/init-config.ts`.
//!
//! `init-config` / `config template` — emit one of the three shipped Codex
//! config templates. Per spec 08 gotcha 23 the Rust port embeds the template
//! bytes at compile time instead of resolving the repo root at runtime.

use std::path::{Component, Path, PathBuf};

use crate::dispatcher::CliOut;

const TEMPLATE_MODERN: &str = include_str!("../../../../config/codex-modern.json");
const TEMPLATE_LEGACY: &str = include_str!("../../../../config/codex-legacy.json");
const TEMPLATE_MINIMAL: &str = include_str!("../../../../config/minimal-codex.json");

/// Template selector (TS `TEMPLATE_MAP` keys).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TemplateName {
    Modern,
    Legacy,
    Minimal,
}

impl TemplateName {
    pub fn as_str(self) -> &'static str {
        match self {
            TemplateName::Modern => "modern",
            TemplateName::Legacy => "legacy",
            TemplateName::Minimal => "minimal",
        }
    }

    fn content(self) -> &'static str {
        match self {
            TemplateName::Modern => TEMPLATE_MODERN,
            TemplateName::Legacy => TEMPLATE_LEGACY,
            TemplateName::Minimal => TEMPLATE_MINIMAL,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum ParsedArgs {
    Ok {
        template: TemplateName,
        stdout: bool,
        write_path: Option<String>,
    },
    Error(String),
}

fn parse_args(args: &[String]) -> ParsedArgs {
    let mut template = TemplateName::Modern;
    let mut stdout = true;
    let mut write_path: Option<String> = None;

    let mut i = 0usize;
    while i < args.len() {
        let arg = args[i].as_str();
        if arg.is_empty() {
            i += 1;
            continue;
        }
        match arg {
            "modern" => {
                template = TemplateName::Modern;
                i += 1;
                continue;
            }
            "legacy" => {
                template = TemplateName::Legacy;
                i += 1;
                continue;
            }
            "minimal" => {
                template = TemplateName::Minimal;
                i += 1;
                continue;
            }
            "--stdout" => {
                stdout = true;
                i += 1;
                continue;
            }
            "--write" => {
                let Some(next) = args.get(i + 1).filter(|value| !value.is_empty()) else {
                    return ParsedArgs::Error("Missing value for --write".to_string());
                };
                write_path = Some(next.clone());
                stdout = false;
                i += 2;
                continue;
            }
            _ => {}
        }
        if let Some(raw) = arg.strip_prefix("--write=") {
            let value = raw.trim();
            if value.is_empty() {
                return ParsedArgs::Error("Missing value for --write".to_string());
            }
            write_path = Some(value.to_string());
            stdout = false;
            i += 1;
            continue;
        }
        return ParsedArgs::Error(format!("Unknown option: {arg}"));
    }

    ParsedArgs::Ok {
        template,
        stdout,
        write_path,
    }
}

/// Node `path.resolve(cwd, target)` — absolute wins, otherwise join, then
/// lexically collapse `.`/`..` components.
fn resolve_from(cwd: &Path, target: &str) -> PathBuf {
    let target_path = Path::new(target);
    let joined = if target_path.is_absolute() {
        target_path.to_path_buf()
    } else {
        cwd.join(target_path)
    };
    let mut normalized = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    normalized.push(component.as_os_str());
                }
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

/// Seam-injectable core (the TS deps: readTemplate / writeTemplate / cwd).
pub async fn run_init_config_with(
    args: &[String],
    read_template: impl FnOnce(TemplateName) -> Result<String, String>,
    write_template: impl FnOnce(&Path, &str) -> Result<(), String>,
    cwd: &Path,
    out: &mut CliOut,
) -> i32 {
    let parsed = match parse_args(args) {
        ParsedArgs::Ok {
            template,
            stdout,
            write_path,
        } => (template, stdout, write_path),
        ParsedArgs::Error(message) => {
            out.error(message);
            return 1;
        }
    };
    let (template, stdout, write_path) = parsed;

    let content = match read_template(template) {
        Ok(content) => content,
        Err(message) => {
            out.error(message);
            return 1;
        }
    };

    if stdout || write_path.is_none() {
        out.info(content.trim_end().to_string());
        return 0;
    }

    let output_path = resolve_from(cwd, write_path.as_deref().unwrap_or(""));
    let final_content = if content.ends_with('\n') {
        content
    } else {
        format!("{content}\n")
    };
    if let Err(message) = write_template(&output_path, &final_content) {
        out.error(message);
        return 1;
    }
    out.info(format!(
        "Wrote {} template to {}",
        template.as_str(),
        output_path.display()
    ));
    0
}

/// Production entry (TS `runInitConfigCommand(args)`): embedded templates +
/// plain (non-atomic, TS parity) mkdir+write.
pub async fn run_init_config_command(args: &[String], out: &mut CliOut) -> i32 {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    run_init_config_with(
        args,
        |template| Ok(template.content().to_string()),
        |path, content| {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            std::fs::write(path, content).map_err(|error| error.to_string())
        },
        &cwd,
        out,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn no_write(_path: &Path, _content: &str) -> Result<(), String> {
        panic!("write_template must not be called");
    }

    // Port of test/init-config-command.test.ts highlights.

    #[tokio::test]
    async fn defaults_to_the_modern_template_on_stdout() {
        let mut out = CliOut::capture();
        let code = run_init_config_with(
            &[],
            |template| {
                assert_eq!(template, TemplateName::Modern);
                Ok("{ \"a\": 1 }\n\n".to_string())
            },
            no_write,
            Path::new("/work"),
            &mut out,
        )
        .await;
        assert_eq!(code, 0);
        assert_eq!(out.info_text(), "{ \"a\": 1 }");
    }

    #[tokio::test]
    async fn selects_named_templates() {
        for (name, expected) in [
            ("legacy", TemplateName::Legacy),
            ("minimal", TemplateName::Minimal),
            ("modern", TemplateName::Modern),
        ] {
            let mut out = CliOut::capture();
            let code = run_init_config_with(
                &args(&[name]),
                |template| {
                    assert_eq!(template, expected);
                    Ok("x".to_string())
                },
                no_write,
                Path::new("/work"),
                &mut out,
            )
            .await;
            assert_eq!(code, 0);
        }
    }

    #[tokio::test]
    async fn rejects_unknown_options_and_missing_write_values() {
        let mut out = CliOut::capture();
        let code = run_init_config_with(
            &args(&["--bogus"]),
            |_| Ok(String::new()),
            no_write,
            Path::new("/work"),
            &mut out,
        )
        .await;
        assert_eq!(code, 1);
        assert_eq!(out.error_text(), "Unknown option: --bogus");

        for bad in [&["--write"][..], &["--write="]] {
            let mut out = CliOut::capture();
            let code = run_init_config_with(
                &args(bad),
                |_| Ok(String::new()),
                no_write,
                Path::new("/work"),
                &mut out,
            )
            .await;
            assert_eq!(code, 1);
            assert_eq!(out.error_text(), "Missing value for --write");
        }
    }

    #[tokio::test]
    async fn write_mode_appends_trailing_newline_and_reports_path() {
        let mut out = CliOut::capture();
        let written = std::sync::Mutex::new(Option::<(PathBuf, String)>::None);
        let code = run_init_config_with(
            &args(&["minimal", "--write", "out/config.json"]),
            |_| Ok("{}".to_string()),
            |path, content| {
                *written.lock().unwrap() = Some((path.to_path_buf(), content.to_string()));
                Ok(())
            },
            Path::new("/work"),
            &mut out,
        )
        .await;
        assert_eq!(code, 0);
        let (path, content) = written.lock().unwrap().clone().unwrap();
        assert_eq!(content, "{}\n");
        assert!(path.ends_with(Path::new("out/config.json")));
        let text = out.info_text();
        assert!(text.starts_with("Wrote minimal template to "));
        assert!(text.contains("config.json"));
    }

    #[tokio::test]
    async fn read_failure_prints_the_message() {
        let mut out = CliOut::capture();
        let code = run_init_config_with(
            &[],
            |_| Err("ENOENT: template".to_string()),
            no_write,
            Path::new("/work"),
            &mut out,
        )
        .await;
        assert_eq!(code, 1);
        assert_eq!(out.error_text(), "ENOENT: template");
    }

    #[test]
    fn embedded_templates_are_valid_json() {
        for template in [
            TemplateName::Modern,
            TemplateName::Legacy,
            TemplateName::Minimal,
        ] {
            serde_json::from_str::<serde_json::Value>(template.content())
                .unwrap_or_else(|error| panic!("{} template invalid: {error}", template.as_str()));
        }
    }

    #[test]
    fn resolve_from_collapses_relative_segments() {
        assert_eq!(
            resolve_from(Path::new("/work/sub"), "../x.json"),
            PathBuf::from("/work/x.json")
        );
        assert_eq!(
            resolve_from(Path::new("/work"), "./a/./b.json"),
            PathBuf::from("/work/a/b.json")
        );
    }
}
