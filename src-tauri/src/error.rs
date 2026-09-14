use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AppErrorCode {
    AppBootstrapFailed,
    CommandHandlerMissing,
    CommandSerializationInvalid,
    InfrastructureFailure,
    ValidationFailed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppErrorDto {
    pub code: AppErrorCode,
    pub message: String,
    pub operation_id: Option<String>,
    pub resource_id: Option<String>,
    pub task_id: Option<String>,
}

impl AppErrorDto {
    pub fn infrastructure(message: impl Into<String>) -> Self {
        Self {
            code: AppErrorCode::InfrastructureFailure,
            message: message.into(),
            operation_id: None,
            resource_id: None,
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
}
