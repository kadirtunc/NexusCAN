//! GitHub release update check (contract `planning/contracts/update-check-v1.md`).
//!
//! Check + notify only: no download, no install. One anonymous HTTPS GET against the GitHub
//! Releases API with an 8 s global timeout, run on the Tokio blocking pool by the command
//! wrappers in `commands.rs`. Never touches the CAN hot path or the 60 Hz telemetry threads.

use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::time::Duration;
use thiserror::Error;

/// Anonymous Releases API endpoint (draft/prerelease entries are filtered client-side).
pub const RELEASES_API_URL: &str =
    "https://api.github.com/repos/kadirtunc/NexusCAN/releases?per_page=15";
/// Public Releases page; also the only URL prefix `cmd_open_release_page` will open.
pub const RELEASES_PAGE_URL: &str = "https://github.com/kadirtunc/NexusCAN/releases";
/// Total request budget (connect + TLS + headers + body).
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);
/// Max release-notes size forwarded to the UI (cut on a UTF-8 char boundary).
pub const MAX_NOTES_BYTES: usize = 16 * 1024;
/// Max entries in `UpdateCheckDto::newer_releases`.
pub const MAX_NEWER_RELEASES: usize = 10;
/// Hard cap on the API response body (15 releases with long notes stay far below this).
const MAX_RESPONSE_BYTES: u64 = 4 * 1024 * 1024;
/// Hard cap on a URL accepted by `cmd_open_release_page`.
const MAX_OPEN_URL_LEN: usize = 2048;

/// Version of this binary (`src-tauri/Cargo.toml`, kept equal to `tauri.conf.json`).
pub const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Installed app version for the always-visible status-bar label (no network).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppVersionDto {
    pub version: String,
    /// `None` = local/dev build (no `NEXUS_BUILD_NUMBER` at compile time).
    pub build: Option<u32>,
}

pub fn app_version() -> AppVersionDto {
    AppVersionDto {
        version: CURRENT_VERSION.to_string(),
        build: current_build(),
    }
}

/// CI run number embedded at build time (`NEXUS_BUILD_NUMBER`); `None` for local/dev builds.
pub fn current_build() -> Option<u32> {
    option_env!("NEXUS_BUILD_NUMBER").and_then(|s| s.trim().parse::<u32>().ok())
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseInfoDto {
    pub tag: String,
    pub name: String,
    pub version: String,
    pub build: u32,
    pub published_at: String,
    pub notes_markdown: String,
    pub html_url: String,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckDto {
    pub current_version: String,
    pub current_build: Option<u32>,
    pub update_available: bool,
    pub latest: Option<ReleaseInfoDto>,
    pub newer_releases: Vec<ReleaseInfoDto>,
    pub releases_page_url: String,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum UpdateCheckError {
    #[error("update check: offline or GitHub unreachable ({0})")]
    Offline(String),
    #[error("update check: timed out after 8 s")]
    Timeout,
    #[error("update check: GitHub API rate limit reached (HTTP {0}); try again later")]
    RateLimited(u16),
    #[error("update check: GitHub API returned HTTP {0}")]
    HttpStatus(u16),
    #[error("update check: unexpected GitHub API response ({0})")]
    Decode(String),
    #[error("update check: request failed ({0})")]
    Request(String),
    #[error("refusing to open URL outside {RELEASES_PAGE_URL}")]
    UrlNotAllowed,
}

/// Subset of the GitHub release object we consume. Missing/null fields degrade to defaults.
#[derive(Debug, Deserialize, Default)]
pub(crate) struct GhRelease {
    #[serde(default)]
    tag_name: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    html_url: String,
}

/// `major.minor.patch` triple; ordered lexicographically.
type Semver = (u64, u64, u64);

fn parse_decimal_u64(s: &str) -> Option<u64> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse::<u64>().ok()
}

fn parse_semver(s: &str) -> Option<Semver> {
    let mut it = s.split('.');
    let major = parse_decimal_u64(it.next()?)?;
    let minor = parse_decimal_u64(it.next()?)?;
    let patch = parse_decimal_u64(it.next()?)?;
    if it.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

/// Parses `^v(\d+\.\d+\.\d+)-build\.(\d+)$` into `(version, build)`.
pub fn parse_tag(tag: &str) -> Option<(String, u32)> {
    let rest = tag.strip_prefix('v')?;
    let (version, build) = rest.split_once("-build.")?;
    parse_semver(version)?;
    if build.is_empty() || !build.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let build = build.parse::<u32>().ok()?;
    Some((version.to_string(), build))
}

/// Cuts `s` to at most `max` bytes without splitting a UTF-8 character.
pub fn truncate_utf8(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// Release ordering: build number first, semver as tie-break.
fn release_cmp(a: &ReleaseInfoDto, b: &ReleaseInfoDto) -> Ordering {
    a.build
        .cmp(&b.build)
        .then_with(|| parse_semver(&a.version).cmp(&parse_semver(&b.version)))
}

/// `true` if `rel` is newer than the running binary. Dev builds (`current_build == None`) never
/// see an update.
pub fn is_newer(rel: &ReleaseInfoDto, current_version: &str, current_build: Option<u32>) -> bool {
    let Some(cur_build) = current_build else {
        return false;
    };
    match rel.build.cmp(&cur_build) {
        Ordering::Greater => true,
        Ordering::Less => false,
        Ordering::Equal => match (parse_semver(&rel.version), parse_semver(current_version)) {
            (Some(r), Some(c)) => r > c,
            _ => false,
        },
    }
}

fn to_release_info(gh: GhRelease) -> Option<ReleaseInfoDto> {
    if gh.draft || gh.prerelease {
        return None;
    }
    let (version, build) = parse_tag(&gh.tag_name)?;
    let notes = gh.body.unwrap_or_default();
    let name = gh
        .name
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| gh.tag_name.clone());
    Some(ReleaseInfoDto {
        tag: gh.tag_name,
        name,
        version,
        build,
        published_at: gh.published_at.unwrap_or_default(),
        notes_markdown: truncate_utf8(&notes, MAX_NOTES_BYTES).to_string(),
        html_url: gh.html_url,
    })
}

/// Pure decision step (unit-tested without network).
pub(crate) fn build_update_check(
    raw: Vec<GhRelease>,
    current_version: &str,
    current_build: Option<u32>,
) -> UpdateCheckDto {
    let mut releases: Vec<ReleaseInfoDto> = raw.into_iter().filter_map(to_release_info).collect();
    releases.sort_by(|a, b| release_cmp(b, a)); // newest first
    let latest = releases.first().cloned();
    let newer_releases: Vec<ReleaseInfoDto> = match current_build {
        None => latest.iter().cloned().collect(),
        Some(_) => releases
            .into_iter()
            .filter(|r| is_newer(r, current_version, current_build))
            .take(MAX_NEWER_RELEASES)
            .collect(),
    };
    let update_available = latest
        .as_ref()
        .is_some_and(|l| is_newer(l, current_version, current_build));
    UpdateCheckDto {
        current_version: current_version.to_string(),
        current_build,
        update_available,
        latest,
        newer_releases,
        releases_page_url: RELEASES_PAGE_URL.to_string(),
    }
}

pub(crate) fn parse_releases_json(json: &str) -> Result<Vec<GhRelease>, UpdateCheckError> {
    serde_json::from_str(json).map_err(|e| UpdateCheckError::Decode(e.to_string()))
}

fn map_transport_error(e: ureq::Error) -> UpdateCheckError {
    match e {
        ureq::Error::Timeout(_) => UpdateCheckError::Timeout,
        ureq::Error::HostNotFound => UpdateCheckError::Offline("DNS lookup failed".into()),
        ureq::Error::ConnectionFailed => UpdateCheckError::Offline("connection failed".into()),
        ureq::Error::Io(io) => match io.kind() {
            std::io::ErrorKind::TimedOut => UpdateCheckError::Timeout,
            _ => UpdateCheckError::Offline(io.to_string()),
        },
        ureq::Error::StatusCode(code) => status_error(code),
        ureq::Error::BodyExceedsLimit(_) => {
            UpdateCheckError::Decode("response body too large".into())
        }
        ureq::Error::Json(j) => UpdateCheckError::Decode(j.to_string()),
        other => UpdateCheckError::Request(other.to_string()),
    }
}

fn status_error(code: u16) -> UpdateCheckError {
    match code {
        403 | 429 => UpdateCheckError::RateLimited(code),
        _ => UpdateCheckError::HttpStatus(code),
    }
}

/// Blocking network check. Call only from the blocking pool.
pub fn check_for_update_blocking() -> Result<UpdateCheckDto, UpdateCheckError> {
    let config = ureq::Agent::config_builder()
        .timeout_global(Some(REQUEST_TIMEOUT))
        .http_status_as_error(false)
        .https_only(true)
        .build();
    let agent: ureq::Agent = config.into();
    let mut resp = agent
        .get(RELEASES_API_URL)
        .header("User-Agent", format!("NexusCAN/{CURRENT_VERSION}"))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .call()
        .map_err(map_transport_error)?;
    let status = resp.status().as_u16();
    if status != 200 {
        return Err(status_error(status));
    }
    let body = resp
        .body_mut()
        .with_config()
        .limit(MAX_RESPONSE_BYTES)
        .read_to_string()
        .map_err(map_transport_error)?;
    let raw = parse_releases_json(&body)?;
    Ok(build_update_check(raw, CURRENT_VERSION, current_build()))
}

/// Resolves the URL `cmd_open_release_page` may open: `None` -> releases page; `Some(u)` only if
/// `u` is the releases page or a path/query/fragment below it on the same repo.
pub fn resolve_release_url(url: Option<String>) -> Result<String, UpdateCheckError> {
    let Some(url) = url else {
        return Ok(RELEASES_PAGE_URL.to_string());
    };
    if is_allowed_release_url(&url) {
        Ok(url)
    } else {
        Err(UpdateCheckError::UrlNotAllowed)
    }
}

pub fn is_allowed_release_url(url: &str) -> bool {
    if url.len() > MAX_OPEN_URL_LEN
        || url
            .chars()
            .any(|c| c.is_control() || c.is_whitespace() || c == '\\')
    {
        return false;
    }
    let Some(rest) = url.strip_prefix(RELEASES_PAGE_URL) else {
        return false;
    };
    // Prefix must end on a path boundary (`/releasesX`, `/releases.evil` rejected).
    if !(rest.is_empty() || rest.starts_with(['/', '?', '#'])) {
        return false;
    }
    // No dot segments that a browser would normalize out of `/releases` (raw or %-encoded).
    let path = rest.split(['?', '#']).next().unwrap_or_default();
    let lower = path.to_ascii_lowercase();
    !(lower.contains("%2e")
        || lower.contains("%2f")
        || path.split('/').any(|s| s == ".." || s == "."))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Trimmed copy of a real `GET /repos/kadirtunc/NexusCAN/releases` response (+ synthetic
    /// draft, prerelease and malformed-tag entries).
    const SAMPLE_JSON: &str = r###"[
      {"tag_name":"v0.1.0-build.18","name":"NexusCAN 0.1.0 (build 18)","draft":false,"prerelease":false,
       "published_at":"2026-11-20T10:00:00Z","body":"## Changes\n- MCP M3",
       "html_url":"https://github.com/kadirtunc/NexusCAN/releases/tag/v0.1.0-build.18","assets":[]},
      {"tag_name":"v0.1.0-build.19","name":"draft","draft":true,"prerelease":false,
       "published_at":null,"body":null,"html_url":"https://github.com/kadirtunc/NexusCAN/releases/tag/untagged"},
      {"tag_name":"v0.1.0-build.20","name":"rc","draft":false,"prerelease":true,
       "published_at":"2026-11-21T10:00:00Z","body":"rc",
       "html_url":"https://github.com/kadirtunc/NexusCAN/releases/tag/v0.1.0-build.20"},
      {"tag_name":"nightly","name":"nightly","draft":false,"prerelease":false,
       "published_at":"2026-11-21T10:00:00Z","body":"x","html_url":"https://github.com/kadirtunc/NexusCAN/releases/tag/nightly"},
      {"tag_name":"v0.1.0-build.16","name":"","draft":false,"prerelease":false,
       "published_at":"2026-11-18T10:00:00Z","body":null,
       "html_url":"https://github.com/kadirtunc/NexusCAN/releases/tag/v0.1.0-build.16"},
      {"tag_name":"v0.1.0-build.17","name":"NexusCAN 0.1.0 (build 17)","draft":false,"prerelease":false,
       "published_at":"2026-11-19T10:00:00Z","body":"b17",
       "html_url":"https://github.com/kadirtunc/NexusCAN/releases/tag/v0.1.0-build.17"}
    ]"###;

    fn sample() -> Vec<GhRelease> {
        parse_releases_json(SAMPLE_JSON).unwrap()
    }

    fn gh(build: u32) -> GhRelease {
        GhRelease {
            tag_name: format!("v0.1.0-build.{build}"),
            html_url: format!("{RELEASES_PAGE_URL}/tag/v0.1.0-build.{build}"),
            ..GhRelease::default()
        }
    }

    #[test]
    fn parse_tag_valid() {
        assert_eq!(parse_tag("v0.1.0-build.18"), Some(("0.1.0".into(), 18)));
        assert_eq!(parse_tag("v12.34.56-build.0"), Some(("12.34.56".into(), 0)));
    }

    #[test]
    fn parse_tag_invalid() {
        for t in [
            "",
            "0.1.0-build.18",
            "v0.1-build.18",
            "v0.1.0.1-build.18",
            "v0.1.0-build.",
            "v0.1.0-build.18a",
            "v0.1.0-build.+18",
            "v0.1.0-build.-1",
            "v0.1.0-build.99999999999",
            "v0.1.0-rc.1",
            "v0.1.0-build.18 ",
            " v0.1.0-build.18",
            "v+0.1.0-build.18",
            "va.b.c-build.1",
            "nightly",
        ] {
            assert_eq!(parse_tag(t), None, "{t:?}");
        }
    }

    fn rel(version: &str, build: u32) -> ReleaseInfoDto {
        ReleaseInfoDto {
            tag: format!("v{version}-build.{build}"),
            name: String::new(),
            version: version.into(),
            build,
            published_at: String::new(),
            notes_markdown: String::new(),
            html_url: String::new(),
        }
    }

    #[test]
    fn compare_dev_equal_older_newer() {
        let r = rel("0.1.0", 18);
        assert!(!is_newer(&r, "0.1.0", None), "dev build never updates");
        assert!(!is_newer(&r, "0.1.0", Some(18)), "equal");
        assert!(!is_newer(&r, "0.1.0", Some(19)), "older release");
        assert!(is_newer(&r, "0.1.0", Some(17)), "newer build");
        assert!(
            is_newer(&rel("0.2.0", 18), "0.1.0", Some(18)),
            "semver tie-break"
        );
        assert!(!is_newer(&rel("0.1.0", 18), "0.2.0", Some(18)));
    }

    #[test]
    fn dto_from_sample_released_build() {
        let dto = build_update_check(sample(), "0.1.0", Some(16));
        assert!(dto.update_available);
        let latest = dto.latest.as_ref().unwrap();
        assert_eq!(latest.tag, "v0.1.0-build.18");
        assert_eq!(latest.build, 18);
        assert_eq!(latest.version, "0.1.0");
        assert_eq!(latest.published_at, "2026-11-20T10:00:00Z");
        let tags: Vec<&str> = dto.newer_releases.iter().map(|r| r.tag.as_str()).collect();
        assert_eq!(tags, ["v0.1.0-build.18", "v0.1.0-build.17"]);
        assert_eq!(dto.releases_page_url, RELEASES_PAGE_URL);
        // empty name falls back to the tag
        let all = build_update_check(sample(), "0.1.0", Some(0));
        assert_eq!(all.newer_releases.last().unwrap().name, "v0.1.0-build.16");
    }

    #[test]
    fn dto_from_sample_dev_and_current() {
        let dev = build_update_check(sample(), "0.1.0", None);
        assert!(!dev.update_available);
        assert_eq!(dev.current_build, None);
        assert_eq!(dev.newer_releases.len(), 1);
        assert_eq!(dev.newer_releases[0].build, 18);
        let cur = build_update_check(sample(), "0.1.0", Some(18));
        assert!(!cur.update_available);
        assert!(cur.newer_releases.is_empty());
        assert_eq!(cur.latest.unwrap().build, 18);
        let empty = build_update_check(Vec::new(), "0.1.0", Some(1));
        assert!(!empty.update_available && empty.latest.is_none());
    }

    #[test]
    fn newer_releases_sorted_and_capped() {
        let raw: Vec<GhRelease> = [5, 30, 12, 7, 25, 9, 40, 3, 18, 33, 21, 14, 2, 27, 36]
            .into_iter()
            .map(gh)
            .collect();
        let dto = build_update_check(raw, "0.1.0", Some(4));
        assert_eq!(dto.newer_releases.len(), MAX_NEWER_RELEASES);
        let builds: Vec<u32> = dto.newer_releases.iter().map(|r| r.build).collect();
        assert_eq!(builds, [40, 36, 33, 30, 27, 25, 21, 18, 14, 12]);
        assert_eq!(dto.latest.unwrap().build, 40);
    }

    #[test]
    fn truncate_multibyte_boundary() {
        assert_eq!(truncate_utf8("abc", 16), "abc");
        // 'ş' = 2 bytes, '°' = 2 bytes, '€' = 3 bytes, '🚗' = 4 bytes
        let s = "aş°€🚗";
        assert_eq!(truncate_utf8(s, 2), "a");
        assert_eq!(truncate_utf8(s, 3), "aş");
        assert_eq!(truncate_utf8(s, 7), "aş°");
        assert_eq!(truncate_utf8(s, 10), "aş°€");
        assert_eq!(truncate_utf8(s, 0), "");
        let long = "€".repeat(MAX_NOTES_BYTES); // 3 * 16384 bytes
        let cut = truncate_utf8(&long, MAX_NOTES_BYTES);
        assert!(cut.len() <= MAX_NOTES_BYTES && cut.len() > MAX_NOTES_BYTES - 3);
        assert!(cut.chars().all(|c| c == '€'));
        // through the DTO path
        let mut g = gh(50);
        g.body = Some(long);
        let dto = build_update_check(vec![g], "0.1.0", Some(1));
        assert!(dto.latest.unwrap().notes_markdown.len() <= MAX_NOTES_BYTES);
    }

    #[test]
    fn url_whitelist() {
        assert_eq!(resolve_release_url(None).unwrap(), RELEASES_PAGE_URL);
        for ok in [
            "https://github.com/kadirtunc/NexusCAN/releases",
            "https://github.com/kadirtunc/NexusCAN/releases/",
            "https://github.com/kadirtunc/NexusCAN/releases/tag/v0.1.0-build.18",
            "https://github.com/kadirtunc/NexusCAN/releases/latest",
            "https://github.com/kadirtunc/NexusCAN/releases?page=2",
            "https://github.com/kadirtunc/NexusCAN/releases#v0.1.0",
        ] {
            assert!(is_allowed_release_url(ok), "{ok}");
            assert_eq!(resolve_release_url(Some(ok.into())).unwrap(), ok);
        }
        for bad in [
            "https://github.com/kadirtunc/NexusCAN.evil",
            "https://github.com/kadirtunc/NexusCAN.evil/releases",
            "https://github.com/kadirtunc/NexusCAN/releasesX",
            "https://github.com/kadirtunc/NexusCAN/releases.evil.com",
            "https://github.com/kadirtunc/NexusCAN/releases@evil.com",
            "http://github.com/kadirtunc/NexusCAN/releases",
            "https://github.com/someone/NexusCAN/releases",
            "https://github.com/kadirtunc/OtherRepo/releases",
            "https://github.com/kadirtunc/NexusCAN",
            "https://github.com/kadirtunc/NexusCAN/releases/../../evil/repo",
            "https://github.com/kadirtunc/NexusCAN/releases/%2e%2e/x",
            "https://github.com/kadirtunc/NexusCAN/releases/ x",
            "https://github.com/kadirtunc/NexusCAN/releases/\\evil",
            "https://github.com/kadirtunc/NexusCAN/releases/\nx",
            "javascript:alert(1)",
            "file:///etc/passwd",
            "",
        ] {
            assert!(!is_allowed_release_url(bad), "{bad:?}");
            assert_eq!(
                resolve_release_url(Some(bad.into())),
                Err(UpdateCheckError::UrlNotAllowed)
            );
        }
        let long = format!("{RELEASES_PAGE_URL}/{}", "a".repeat(MAX_OPEN_URL_LEN));
        assert!(!is_allowed_release_url(&long));
    }

    #[test]
    fn status_mapping() {
        assert_eq!(status_error(403), UpdateCheckError::RateLimited(403));
        assert_eq!(status_error(429), UpdateCheckError::RateLimited(429));
        assert_eq!(status_error(500), UpdateCheckError::HttpStatus(500));
        assert!(parse_releases_json("{\"message\":\"x\"}").is_err());
    }

    /// Live GitHub API check (network). `cargo test -p nexuscan-tauri update_check -- --ignored`
    #[test]
    #[ignore]
    fn live_github_releases() {
        let dto = check_for_update_blocking().unwrap();
        let latest = dto.latest.expect("at least one release");
        eprintln!(
            "live latest = {} (build {}), newer = {}",
            latest.tag,
            latest.build,
            dto.newer_releases.len()
        );
        assert!(latest.build >= 18);
        assert!(is_allowed_release_url(&latest.html_url));
    }
}
