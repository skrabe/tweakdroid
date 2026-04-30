---
id: openai_markdown_spec
symbol: n6L
provider: openai
mode: always
description: Always appended for OpenAI provider models.
source_sha256: d8a0e18b8eafc23d8f16128e063fa30758fdf5ab89c040d1d4ae020344d776d0
---

<markdown_spec>
Final responses use GitHub-flavored Markdown when it improves readability.

- Default to concise plain paragraphs.
- Use headers, bullets, or numbered lists when they make comparisons, steps, or caveats easier to scan.
- Use fenced code blocks for code, diffs, and command output.
- Use `inline code` for paths, commands, identifiers, and short snippets.
- Follow any user-requested response format over these defaults.
</markdown_spec>
