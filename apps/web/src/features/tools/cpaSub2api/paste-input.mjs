// Adapted from https://github.com/gtxx3600/CPA2sub2API at commit 42ff785d5f3527e4050c02a0da51d4f7eb4f1180 (MIT).
function makeLabel(index, suffix = "") {
  return `粘贴内容 #${index + 1}${suffix}`;
}

function isWhitespace(value) {
  return /\s/u.test(value);
}

function parseCandidate(candidate, index) {
  try {
    return {
      document: JSON.parse(candidate.text),
      issue: undefined,
    };
  } catch (error) {
    return {
      document: undefined,
      issue: {
        label: makeLabel(index),
        reason: error instanceof Error ? `JSON 解析失败：${error.message}` : "JSON 解析失败",
      },
    };
  }
}

export function parsePastedJsonDocuments(text) {
  const input = String(text || "");
  const documents = [];
  const issues = [];
  let depth = 0;
  let startIndex = -1;
  let inString = false;
  let escaped = false;
  let documentIndex = 0;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];

    if (startIndex === -1) {
      if (isWhitespace(char)) {
        continue;
      }

      if (char !== "{" && char !== "[") {
        issues.push({
          label: makeLabel(documentIndex),
          reason: `JSON 文档必须以 { 或 [ 开始，当前位置是 ${JSON.stringify(char)}`,
        });
        break;
      }

      startIndex = index;
      depth = 1;
      inString = false;
      escaped = false;
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{" || char === "[") {
      depth += 1;
      continue;
    }

    if (char === "}" || char === "]") {
      depth -= 1;

      if (depth === 0) {
        const candidate = {
          text: input.slice(startIndex, index + 1),
        };
        const parsed = parseCandidate(candidate, documentIndex);

        if (parsed.issue) {
          issues.push(parsed.issue);
        } else {
          documents.push(parsed.document);
        }

        documentIndex += 1;
        startIndex = -1;
      }
    }
  }

  if (startIndex !== -1) {
    issues.push({
      label: makeLabel(documentIndex),
      reason: "JSON 不完整：缺少顶层闭合括号",
    });
  }

  if (!documents.length && !issues.length && input.trim() !== "") {
    issues.push({
      label: makeLabel(0),
      reason: "没有找到可解析的 JSON 文档",
    });
  }

  return { documents, issues };
}

export function buildPastedInputItems(documents, mode) {
  return documents.flatMap((document, index) => {
    if (mode === "cpaToSub2Api" && Array.isArray(document)) {
      return document.map((item, itemIndex) => ({
        document: item,
        sourceName: makeLabel(index, `.${itemIndex + 1}`),
      }));
    }

    return [{
      document,
      sourceName: makeLabel(index),
    }];
  });
}
