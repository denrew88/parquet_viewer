use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DataBoundaryDirection {
    Up,
    Down,
    Left,
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DataBoundaryMode {
    DataBoundary,
    TableBoundary,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FindBoundaryRequest {
    pub navigation_id: String,
    pub document_id: String,
    pub session_id: String,
    pub query_id: Option<String>,
    pub row: i64,
    pub column_id: String,
    pub visible_column_ids: Vec<String>,
    pub direction: DataBoundaryDirection,
    pub mode: DataBoundaryMode,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FindBoundaryResponse {
    pub navigation_id: String,
    pub document_id: String,
    pub session_id: String,
    pub query_id: Option<String>,
    pub target_row: u64,
    pub target_column_id: String,
    pub resolved_row_count: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CancelDataBoundaryNavigationRequest {
    pub navigation_id: String,
    pub document_id: String,
    pub session_id: String,
    pub query_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoundarySearchRequest {
    pub row: u64,
    pub column_id: String,
    pub visible_column_ids: Vec<String>,
    pub direction: DataBoundaryDirection,
    pub mode: DataBoundaryMode,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoundarySearchResult {
    pub target_row: u64,
    pub target_column_id: String,
    pub resolved_row_count: Option<u64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boundary_wire_uses_the_fixed_camel_case_contract() {
        let request: FindBoundaryRequest = serde_json::from_value(serde_json::json!({
            "navigationId": "navigation-1",
            "documentId": "document-1",
            "sessionId": "session-1",
            "row": 7,
            "columnId": "value",
            "visibleColumnIds": ["time", "value"],
            "direction": "down",
            "mode": "dataBoundary"
        }))
        .expect("fixed boundary request wire");
        assert_eq!(request.direction, DataBoundaryDirection::Down);
        assert_eq!(request.mode, DataBoundaryMode::DataBoundary);

        let response = serde_json::to_value(FindBoundaryResponse {
            navigation_id: request.navigation_id,
            document_id: request.document_id,
            session_id: request.session_id,
            query_id: None,
            target_row: 10,
            target_column_id: String::from("value"),
            resolved_row_count: Some(11),
        })
        .expect("fixed boundary response wire");
        assert_eq!(response["targetRow"], 10);
        assert_eq!(response["resolvedRowCount"], 11);
        assert!(response.get("direction").is_none());
    }

    #[test]
    fn boundary_wire_rejects_unknown_direction_mode_and_fields() {
        let base = serde_json::json!({
            "navigationId": "navigation-1",
            "documentId": "document-1",
            "sessionId": "session-1",
            "row": 0,
            "columnId": "value",
            "visibleColumnIds": ["value"],
            "direction": "diagonal",
            "mode": "dataBoundary"
        });
        assert!(serde_json::from_value::<FindBoundaryRequest>(base).is_err());
    }
}
