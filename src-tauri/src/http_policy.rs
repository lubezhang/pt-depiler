use reqwest::Method;
use serde_json::Value;
use std::net::{IpAddr, SocketAddr};
use std::time::Duration;
use url::Url;

#[derive(Default)]
pub struct HttpPolicy;

fn invalid(reason: &str) -> String {
    format!("HTTP_POLICY_REJECTED:{reason}")
}

fn is_private_host(url: &Url) -> bool {
    match url.host() {
        Some(url::Host::Ipv4(ip)) => {
            ip.is_private() || ip.is_loopback() || ip.is_link_local() || ip.is_unspecified()
        }
        Some(url::Host::Ipv6(ip)) => {
            let first_segment = ip.segments()[0];
            ip.is_loopback()
                || ip.is_unspecified()
                || first_segment & 0xfe00 == 0xfc00
                || first_segment & 0xffc0 == 0xfe80
        }
        Some(url::Host::Domain(host)) => {
            host.eq_ignore_ascii_case("localhost") || host.ends_with(".local")
        }
        None => true,
    }
}

fn origin(url: &Url) -> Result<String, String> {
    match url.scheme() {
        "http" | "https" => {}
        _ => return Err(invalid("unsupported_protocol")),
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(invalid("credentials_in_url"));
    }
    Ok(url.origin().ascii_serialization())
}

fn host_key(url: &Url) -> Option<String> {
    let host = url.host_str()?;
    Some(match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    })
}

fn matches_url_value(value: Option<&Value>, request_origin: &str) -> bool {
    value
        .and_then(Value::as_str)
        .and_then(|address| Url::parse(address).ok())
        .is_some_and(|address| {
            origin(&address).is_ok_and(|configured| configured == request_origin)
        })
}

fn matches_address(value: &Value, request_origin: &str) -> bool {
    [
        value.get("address"),
        value.get("endpoint"),
        value.get("url"),
    ]
    .into_iter()
    .any(|address| matches_url_value(address, request_origin))
}

fn matches_s3_bucket(entity: &Value, request_origin: &str) -> bool {
    if entity.get("type").and_then(Value::as_str) != Some("S3") {
        return false;
    }
    let Some(config) = entity.get("config") else {
        return false;
    };
    if config.get("forcePathStyle").and_then(Value::as_bool) == Some(true) {
        return false;
    }
    let Some(bucket) = config.get("bucket").and_then(Value::as_str) else {
        return false;
    };
    if bucket.is_empty()
        || bucket.len() > 63
        || !bucket.chars().all(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || matches!(character, '-' | '.')
        })
    {
        return false;
    }
    let Some(endpoint) = config
        .get("endpoint")
        .and_then(Value::as_str)
        .and_then(|endpoint| Url::parse(endpoint).ok())
    else {
        return false;
    };
    let Some(host) = endpoint.host_str() else {
        return false;
    };
    let mut bucket_url = endpoint.clone();
    if bucket_url
        .set_host(Some(&format!("{bucket}.{host}")))
        .is_err()
    {
        return false;
    }
    origin(&bucket_url).is_ok_and(|configured| configured == request_origin)
}

fn configured_service(metadata: &Value, resource_id: &str, request_origin: &str) -> bool {
    let groups = [
        ("downloader:", "downloaders"),
        ("backup:", "backupServers"),
        ("media:", "mediaServers"),
    ];
    groups.into_iter().any(|(prefix, group)| {
        let Some(id) = resource_id.strip_prefix(prefix) else {
            return false;
        };
        let Some(entities) = metadata.get(group).and_then(Value::as_object) else {
            return false;
        };
        let matches = |entity: &Value| {
            if group == "backupServers" {
                let config = entity.get("config");
                match entity.get("type").and_then(Value::as_str) {
                    Some("WebDAV" | "OWSS" | "CookieCloud") => config.is_some_and(|config| {
                        matches_url_value(config.get("address"), request_origin)
                    }),
                    Some("S3") => {
                        config.is_some_and(|config| {
                            matches_url_value(config.get("endpoint"), request_origin)
                        }) || matches_s3_bucket(entity, request_origin)
                    }
                    _ => false,
                }
            } else {
                matches_address(entity, request_origin)
                    || entity
                        .get("config")
                        .is_some_and(|config| matches_address(config, request_origin))
            }
        };
        if id == "legacy" {
            entities.values().any(matches)
        } else {
            entities.get(id).is_some_and(matches)
        }
    })
}

fn configured_site(metadata: &Value, resource_id: &str, url: &Url) -> bool {
    let Some(host) = host_key(url) else {
        return false;
    };
    let mapped = metadata
        .get("siteHostMap")
        .and_then(|map| map.get(host))
        .and_then(Value::as_str);
    let site_id = if resource_id == "site:legacy" {
        mapped
    } else {
        mapped.filter(|mapped_id| *mapped_id == resource_id)
    };
    site_id.is_some_and(|id| {
        let site = metadata.get("sites").and_then(|sites| sites.get(id));
        site.is_some_and(|site| {
            site.get("url")
                .and_then(Value::as_str)
                .and_then(|value| Url::parse(value).ok())
                .map_or(url.scheme() == "https", |configured| {
                    origin(&configured).ok() == origin(url).ok()
                })
        })
    })
}

fn public_service(resource_id: &str, url: &Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    const HOSTS: &[&str] = &[
        "ourbits.github.io",
        "cdn.ourhelp.club",
        "api.ourhelp.club",
        "movie.douban.com",
        "m.douban.com",
        "img1.doubanio.com",
        "api.tvmaze.com",
        "api.bgm.tv",
        "p.media-imdb.com",
        "cdn.anidb.net",
    ];
    let poster = host.starts_with("img")
        && host.ends_with(".doubanio.com")
        && host[3..host.len() - ".doubanio.com".len()]
            .chars()
            .all(|digit| digit.is_ascii_digit());
    let registered = (HOSTS.contains(&host) || poster) && url.scheme() == "https";
    let anidb = host == "api.anidb.net" && url.scheme() == "http" && url.port() == Some(9001);
    let Some(host) = host_key(url) else {
        return false;
    };
    (registered || anidb)
        && (resource_id == format!("social:{}:{host}", url.scheme())
            || resource_id == format!("legacy:{host}"))
}

fn configured_public_backup(metadata: &Value, resource_id: &str, url: &Url) -> bool {
    if resource_id != "backup:legacy" || url.scheme() != "https" || url.port().is_some() {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    let path = url.path();
    let kind = if host == "www.googleapis.com"
        && (path == "/oauth2/v4/token"
            || path.starts_with("/drive/v3/files")
            || path.starts_with("/upload/drive/v3/files"))
    {
        Some("GoogleDrive")
    } else if matches!(host, "api.dropboxapi.com" | "content.dropboxapi.com")
        && path.starts_with("/2/")
    {
        Some("DropBox")
    } else if host == "api.github.com" && path.starts_with("/gists/") {
        Some("Gist")
    } else if b2_api_host(host) && path.starts_with("/b2api/v2/")
        || b2_download_host(host) && path.starts_with("/file/")
        || b2_upload_host(host) && path.starts_with("/b2api/v2/b2_upload_file/")
    {
        Some("BackblazeB2")
    } else {
        None
    };
    let Some(kind) = kind else {
        return false;
    };
    metadata
        .get("backupServers")
        .and_then(Value::as_object)
        .is_some_and(|servers| {
            servers
                .values()
                .any(|server| server.get("type").and_then(Value::as_str) == Some(kind))
        })
}

fn numbered_host(host: &str, prefix: &str, suffix: &str) -> bool {
    host.strip_prefix(prefix)
        .and_then(|remainder| remainder.strip_suffix(suffix))
        .is_some_and(|number| {
            !number.is_empty() && number.chars().all(|digit| digit.is_ascii_digit())
        })
}

fn b2_api_host(host: &str) -> bool {
    host == "api.backblazeb2.com" || numbered_host(host, "api", ".backblazeb2.com")
}

fn b2_download_host(host: &str) -> bool {
    numbered_host(host, "f", ".backblazeb2.com")
}

fn b2_upload_host(host: &str) -> bool {
    host.strip_prefix("pod-")
        .and_then(|remainder| remainder.strip_suffix(".backblaze.com"))
        .is_some_and(|number| {
            let groups = number.split('-').collect::<Vec<_>>();
            groups.len() == 3
                && groups.iter().all(|group| {
                    !group.is_empty() && group.chars().all(|digit| digit.is_ascii_digit())
                })
        })
}

impl HttpPolicy {
    pub fn requires_public_address(
        &self,
        metadata: &Value,
        resource_id: &str,
        target: &str,
    ) -> bool {
        let Ok(url) = Url::parse(target) else {
            return true;
        };
        let Ok(request_origin) = origin(&url) else {
            return true;
        };
        !(configured_service(metadata, resource_id, &request_origin)
            || resource_id.starts_with("legacy:")
                && ["downloader:legacy", "backup:legacy", "media:legacy"]
                    .iter()
                    .any(|id| configured_service(metadata, id, &request_origin)))
    }

    pub fn validate(
        &self,
        metadata: &Value,
        resource_id: &str,
        method: &Method,
        target: &str,
    ) -> Result<(), String> {
        if !matches!(
            *method,
            Method::GET | Method::POST | Method::PUT | Method::PATCH | Method::DELETE
        ) {
            return Err(invalid("method_not_allowed"));
        }
        let url = Url::parse(target).map_err(|_| invalid("invalid_url"))?;
        let request_origin = origin(&url)?;
        let service = configured_service(metadata, resource_id, &request_origin);
        let site = configured_site(metadata, resource_id, &url) && !is_private_host(&url);
        let public = public_service(resource_id, &url) && !is_private_host(&url);
        let backup_public =
            configured_public_backup(metadata, resource_id, &url) && !is_private_host(&url);
        let legacy = host_key(&url).is_some_and(|host| resource_id == format!("legacy:{host}"))
            && (configured_site(metadata, "site:legacy", &url) && !is_private_host(&url)
                || configured_service(metadata, "downloader:legacy", &request_origin)
                || configured_service(metadata, "backup:legacy", &request_origin)
                || configured_service(metadata, "media:legacy", &request_origin));
        if service || site || public || backup_public || legacy {
            Ok(())
        } else {
            Err(invalid("resource_not_configured"))
        }
    }
}

fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let octets = ip.octets();
            !ip.is_private()
                && !ip.is_loopback()
                && !ip.is_link_local()
                && !ip.is_multicast()
                && !ip.is_unspecified()
                && !ip.is_broadcast()
                && !(octets[0] == 100 && (64..=127).contains(&octets[1]))
                && !(octets[0] == 192 && octets[1] == 0 && octets[2] == 0)
                && !(octets[0] == 192 && octets[1] == 0 && octets[2] == 2)
                && !(octets[0] == 198 && (18..=19).contains(&octets[1]))
                && !(octets[0] == 198 && octets[1] == 51 && octets[2] == 100)
                && !(octets[0] == 203 && octets[1] == 0 && octets[2] == 113)
                && octets[0] != 0
                && octets[0] < 224
        }
        IpAddr::V6(ip) => {
            let first = ip.segments()[0];
            !(ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_multicast()
                || first & 0xfe00 == 0xfc00
                || first & 0xffc0 == 0xfe80
                || ip.segments()[0] == 0x2001 && matches!(ip.segments()[1], 0 | 0x0db8)
                || first == 0x2002
                || first == 0x0064 && ip.segments()[1] == 0xff9b)
                && ip
                    .to_ipv4_mapped()
                    .map_or(true, |mapped| public_ip(IpAddr::V4(mapped)))
        }
    }
}

pub async fn resolve_connection(
    target: &str,
    require_public: bool,
) -> Result<Vec<SocketAddr>, String> {
    let url = Url::parse(target).map_err(|_| invalid("invalid_url"))?;
    let host = url.host_str().ok_or_else(|| invalid("invalid_url"))?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| invalid("invalid_url"))?;
    let addresses = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::net::lookup_host((host, port)),
    )
    .await
    .map_err(|_| invalid("dns_timeout"))?
    .map_err(|_| invalid("dns_failed"))?
    .collect::<Vec<_>>();
    if addresses.is_empty() {
        return Err(invalid("dns_empty"));
    }
    if require_public && addresses.iter().any(|address| !public_ip(address.ip())) {
        return Err(invalid("private_dns_answer"));
    }
    Ok(addresses)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ap_05_rejects_forged_and_deleted_resources() {
        let policy = HttpPolicy;
        let metadata = json!({
            "sites": { "tracker": {} },
            "siteHostMap": { "tracker.example": "tracker" },
            "downloaders": { "client": { "address": "http://127.0.0.1:8080/api" } }
        });
        assert!(policy
            .validate(
                &metadata,
                "tracker",
                &Method::GET,
                "https://tracker.example/a"
            )
            .is_ok());
        assert!(policy
            .validate(
                &metadata,
                "other",
                &Method::GET,
                "https://tracker.example/a"
            )
            .is_err());
        assert!(policy
            .validate(
                &metadata,
                "downloader:client",
                &Method::GET,
                "http://127.0.0.1:8080/a"
            )
            .is_ok());
        assert!(policy
            .validate(
                &metadata,
                "downloader:client",
                &Method::GET,
                "http://127.0.0.1:9090/a"
            )
            .is_err());
        let deleted = json!({ "sites": {}, "siteHostMap": {}, "downloaders": {} });
        assert!(policy
            .validate(
                &deleted,
                "tracker",
                &Method::GET,
                "https://tracker.example/a"
            )
            .is_err());
    }

    #[test]
    fn ap_05_public_origins_are_explicit() {
        let policy = HttpPolicy;
        let empty = json!({});
        assert!(policy
            .validate(
                &empty,
                "social:https:movie.douban.com",
                &Method::GET,
                "https://movie.douban.com/j/search_subjects"
            )
            .is_ok());
        assert!(policy
            .validate(
                &empty,
                "social:https:evil.example",
                &Method::GET,
                "https://evil.example/"
            )
            .is_err());
        let backup = json!({"backupServers":{"server":{"type":"GoogleDrive","config":{}}}});
        assert!(policy
            .validate(
                &backup,
                "backup:legacy",
                &Method::POST,
                "https://www.googleapis.com/oauth2/v4/token"
            )
            .is_ok());
        assert!(policy
            .validate(
                &empty,
                "backup:legacy",
                &Method::POST,
                "https://www.googleapis.com/oauth2/v4/token"
            )
            .is_err());
    }

    #[tokio::test]
    async fn ap_05_rejects_private_dns_answer_for_public_resource() {
        assert_eq!(
            resolve_connection("http://127.0.0.1:8080/path", true)
                .await
                .unwrap_err(),
            "HTTP_POLICY_REJECTED:private_dns_answer"
        );
        assert_eq!(
            resolve_connection("http://127.0.0.1:8080/path", false)
                .await
                .unwrap()[0]
                .ip()
                .to_string(),
            "127.0.0.1"
        );
        assert!(!public_ip("100.64.0.1".parse().unwrap()));
        assert!(!public_ip("198.18.0.1".parse().unwrap()));
        assert!(!public_ip("192.0.2.1".parse().unwrap()));
        assert!(!public_ip("2001:db8::1".parse().unwrap()));
        assert!(!public_ip("2002:c0a8:0101::1".parse().unwrap()));
        assert!(public_ip("8.8.8.8".parse().unwrap()));
    }

    #[test]
    fn ap_05_allows_configured_s3_bucket_and_b2_dynamic_hosts() {
        let policy = HttpPolicy;
        let metadata = json!({
            "backupServers": {
                "s3": {"type":"S3", "config":{"endpoint":"https://s3.amazonaws.com", "bucket":"my-backup", "forcePathStyle":false}},
                "b2": {"type":"BackblazeB2", "address":"https://evil.example", "config":{"endpoint":"https://evil.example"}}
            }
        });
        assert!(policy
            .validate(
                &metadata,
                "backup:legacy",
                &Method::PUT,
                "https://my-backup.s3.amazonaws.com/backup.zip"
            )
            .is_ok());
        assert!(policy
            .validate(
                &metadata,
                "backup:legacy",
                &Method::POST,
                "https://pod-000-1234-99.backblaze.com/b2api/v2/b2_upload_file/123/token"
            )
            .is_ok());
        assert!(policy
            .validate(
                &metadata,
                "backup:legacy",
                &Method::GET,
                "https://f001.backblazeb2.com/file/my-bucket/backup.zip"
            )
            .is_ok());
        assert!(policy
            .validate(
                &metadata,
                "backup:legacy",
                &Method::GET,
                "https://my-backup.evil.example/backup.zip"
            )
            .is_err());
        assert!(policy
            .validate(
                &metadata,
                "backup:legacy",
                &Method::GET,
                "https://evil.example/"
            )
            .is_err());
        assert!(policy
            .validate(
                &metadata,
                "backup:legacy",
                &Method::POST,
                "https://pod-a-1234-99.backblaze.com/b2api/v2/b2_upload_file/123/token"
            )
            .is_err());
        assert!(policy
            .validate(
                &metadata,
                "backup:legacy",
                &Method::GET,
                "https://f001.backblazeb2.com/admin"
            )
            .is_err());
        let deleted = json!({"backupServers":{}});
        assert!(policy
            .validate(
                &deleted,
                "backup:legacy",
                &Method::GET,
                "https://f001.backblazeb2.com/file/my-bucket/backup.zip"
            )
            .is_err());
    }
}
