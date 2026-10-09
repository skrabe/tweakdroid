---
id: google_execute_cli_risk
fingerprint: "When using the execute-cli tool, you MUST write "
provider: google
mode: built-in-only
description: Appended for built-in Gemini models (registry reminder gemini-risk-level). {{N}} vary with whether the Execute schema has riskLevel.
source_sha256: 6dd45916c2de208d2be0978e0b209f070dee2f8d2cc6a49ab7ff8cefff0285e5
content_sha256: b721186c7178ba6bbbdaaa829c566ab92ba204171e5d6b8da67df9fcf3bf82e1
interpolations: ["T?\"summary, riskLevelReason, and riskLevel\":\"summary\"","T?\"These are critical and required fields\":\"This is a critical and required field\""]
---

When using the execute-cli tool, you MUST write riskLevelReason and riskLevel. These are critical and required fields in the tool input.