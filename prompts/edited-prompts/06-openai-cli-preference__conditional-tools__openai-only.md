---
id: openai_cli_preference
symbol: o6L
provider: openai
mode: conditional
description: Appended for OpenAI only when native file tools are present; keep {{native_tool_list}} where the runtime tool list should appear.
source_sha256: 831faf6f1456fea5a94f28694818b4bf88928f42f793386f65b28b5afa5dccb3
---

<cli_preference_spec>
For these file operations, use Factory native tools instead of shell commands:
{{native_tool_list}}

The `patchapply` command is not available in this environment; do not call it.
</cli_preference_spec>
