use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use ts_rs::TS;

static NEXT_COMMAND_OPERATION: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AppErrorCode {
    AppBootstrapFailed,
    CommandHandlerMissing,
    CommandSerializationInvalid,
    InfrastructureFailure,
    ValidationFailed,
    StorageConflict,
    StorageUnavailable,
    HttpPolicyRejected,
    HttpResponseTooLarge,
    HttpRequestCancelled,
    HttpTimeout,
    FileDownloadFailed,
    IpcInvalidInput,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AppErrorDto {
    pub code: AppErrorCode,
    pub message: String,
    pub operation_id: Option<String>,
    pub resource_id: Option<String>,
    pub task_id: Option<String>,
}

impl AppErrorDto {
    pub fn command(error: &str, command: &str) -> Self {
        let operation_id = format!(
            "{command}-{}",
            NEXT_COMMAND_OPERATION.fetch_add(1, Ordering::Relaxed)
        );
        Self::ipc(error, operation_id, None)
    }

    pub fn infrastructure(message: impl Into<String>) -> Self {
        Self {
            code: AppErrorCode::InfrastructureFailure,
            message: message.into(),
            operation_id: None,
            resource_id: None,
            task_id: None,
        }
    }

    pub fn ipc(error: &str, operation_id: String, resource_id: Option<String>) -> Self {
        let (code, message) = if error.starts_with("STORAGE_CONFLICT") {
            (AppErrorCode::StorageConflict, "配置已被修改，请重读后重试")
        } else if error.starts_with("STORAGE_INVALID") || error.starts_with("STORAGE_CONDITIONAL") {
            (AppErrorCode::IpcInvalidInput, "存储输入无效")
        } else if error.starts_with("STORAGE_") {
            (AppErrorCode::StorageUnavailable, "存储暂不可用")
        } else if error.starts_with("HTTP_POLICY_REJECTED") {
            (AppErrorCode::HttpPolicyRejected, "请求被网络策略拒绝")
        } else if error.starts_with("HTTP_RESPONSE_TOO_LARGE") {
            (AppErrorCode::HttpResponseTooLarge, "响应超过大小限制")
        } else if error.starts_with("FILE_DOWNLOAD_") {
            (AppErrorCode::FileDownloadFailed, "文件下载失败")
        } else if error.starts_with("请求已取消") {
            (AppErrorCode::HttpRequestCancelled, "请求已取消")
        } else if error.contains("请求超时") {
            (AppErrorCode::HttpTimeout, "请求超时")
        } else {
            (AppErrorCode::InfrastructureFailure, "请求失败")
        };
        Self {
            code,
            message: message.to_string(),
            operation_id: Some(operation_id),
            resource_id,
            task_id: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_the_shared_error_envelope() {
        let error = AppErrorDto::infrastructure("disk unavailable");
        assert_eq!(
            serde_json::to_value(error).unwrap()["code"],
            "INFRASTRUCTURE_FAILURE"
        );
    }

    #[test]
    fn ap_01_non_storage_failure_hides_transport_details() {
        let error = AppErrorDto::ipc(
            "HTTP_POLICY_REJECTED:cross_origin_redirect Bearer secret",
            "fetch-1".to_string(),
            Some("site-1".to_string()),
        );
        let serialized = serde_json::to_string(&error).unwrap();
        assert!(serialized.contains("HTTP_POLICY_REJECTED"));
        assert!(serialized.contains("fetch-1"));
        assert!(!serialized.contains("Bearer secret"));
    }

    #[test]
    fn ap_01_command_errors_have_distinct_operation_ids() {
        let first = AppErrorDto::command("Bearer secret", "get_cookies");
        let second = AppErrorDto::command("Bearer secret", "get_cookies");
        assert_ne!(first.operation_id, second.operation_id);
        assert!(!serde_json::to_string(&first)
            .unwrap()
            .contains("Bearer secret"));
    }
}
