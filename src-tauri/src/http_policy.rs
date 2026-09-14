use std::collections::HashMap;
use std::sync::Mutex;

use reqwest::Method;
use serde::Deserialize;
use url::Url;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResourceKind {
    Site,
    Service,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResourceRegistration {
    pub resource_id: String,
    pub endpoint: String,
    pub kind: ResourceKind,
}

#[derive(Clone)]
struct HttpResource {
    origin: String,
    kind: ResourceKind,
}

#[derive(Default)]
pub struct HttpPolicy {
    resources: Mutex<HashMap<String, HttpResource>>,
}

fn invalid(reason: &str) -> String {
    format!("HTTP_POLICY_REJECTED:{reason}")
}

fn is_private_host(url: &Url) -> bool {
    match url.host() {
        Some(url::Host::Ipv4(ip)) => {
            ip.is_private() || ip.is_loopback() || ip.is_link_local() || ip.is_unspecified()
        }
        Some(url::Host::Ipv6(ip)) => {
            ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_unique_local()
                || ip.is_unicast_link_local()
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
    let value = url.origin().ascii_serialization();
    if value == "null" {
        Err(invalid("opaque_origin"))
    } else {
        Ok(value)
    }
}

impl HttpPolicy {
    pub fn register(&self, registration: HttpResourceRegistration) -> Result<(), String> {
        if registration.resource_id.is_empty()
            || registration.resource_id.len() > 160
            || !registration.resource_id.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, ':' | '-' | '_' | '.')
            })
        {
            return Err(invalid("invalid_resource_id"));
        }
        let endpoint =
            Url::parse(&registration.endpoint).map_err(|_| invalid("invalid_endpoint"))?;
        let endpoint_origin = origin(&endpoint)?;
        if matches!(registration.kind, ResourceKind::Site) && is_private_host(&endpoint) {
            return Err(invalid("site_private_network"));
        }
        self.resources
            .lock()
            .map_err(|_| invalid("registry_unavailable"))?
            .insert(
                registration.resource_id,
                HttpResource {
                    origin: endpoint_origin,
                    kind: registration.kind,
                },
            );
        Ok(())
    }

    pub fn validate(&self, resource_id: &str, method: &Method, url: &str) -> Result<(), String> {
        if !matches!(
            *method,
            Method::GET | Method::POST | Method::PUT | Method::PATCH | Method::DELETE
        ) {
            return Err(invalid("method_not_allowed"));
        }
        let url = Url::parse(url).map_err(|_| invalid("invalid_url"))?;
        let request_origin = origin(&url)?;
        let resource = self
            .resources
            .lock()
            .map_err(|_| invalid("registry_unavailable"))?
            .get(resource_id)
            .cloned()
            .ok_or_else(|| invalid("unregistered_resource"))?;
        if resource.origin != request_origin {
            return Err(invalid("cross_origin"));
        }
        if matches!(resource.kind, ResourceKind::Site) && is_private_host(&url) {
            return Err(invalid("site_private_network"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn register(policy: &HttpPolicy, resource_id: &str, endpoint: &str, kind: ResourceKind) {
        policy
            .register(HttpResourceRegistration {
                resource_id: resource_id.to_string(),
                endpoint: endpoint.to_string(),
                kind,
            })
            .unwrap();
    }

    #[test]
    fn rejects_unregistered_and_cross_origin_requests() {
        let policy = HttpPolicy::default();
        assert!(policy
            .validate("site:one", &Method::GET, "https://example.com/")
            .is_err());
        register(
            &policy,
            "site:one",
            "https://example.com",
            ResourceKind::Site,
        );
        assert!(policy
            .validate("site:one", &Method::GET, "https://other.example/")
            .is_err());
    }

    #[test]
    fn blocks_private_network_for_site_but_allows_registered_service() {
        let policy = HttpPolicy::default();
        assert!(policy
            .register(HttpResourceRegistration {
                resource_id: "site:one".to_string(),
                endpoint: "http://127.0.0.1".to_string(),
                kind: ResourceKind::Site
            })
            .is_err());
        register(
            &policy,
            "downloader:one",
            "http://127.0.0.1:8080",
            ResourceKind::Service,
        );
        assert!(policy
            .validate("downloader:one", &Method::GET, "http://127.0.0.1:8080/api")
            .is_ok());
    }
}
