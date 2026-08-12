import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function filesUnder(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name))) files.push(target);
    }
  };
  visit(root);
  return files;
}

function position(source, offset) {
  const prefix = source.slice(0, offset);
  const line = prefix.split("\n").length;
  const lastBreak = prefix.lastIndexOf("\n");
  return { line, column: offset - lastBreak };
}

function site(relative, source, match, spelling) {
  const at = position(source, match.index);
  const lineText = source.split("\n")[at.line - 1]?.trim() ?? "";
  return {
    file: relative,
    line: at.line,
    column: at.column,
    spelling,
    lineHash: sha256(lineText),
  };
}

export function independentProjection(root) {
  const absolute = path.resolve(root);
  const sites = [];
  for (const file of filesUnder(absolute)) {
    const relative = path.relative(absolute, file).split(path.sep).join("/");
    const source = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    for (const match of source.matchAll(/\bfail\s*\(/g)) {
      const prefix = source.slice(Math.max(0, match.index - 32), match.index);
      if (/function\s+$/.test(prefix) || /function\s+fail\s*$/.test(prefix)) continue;
      sites.push(site(relative, source, match, "fail"));
    }
    for (const match of source.matchAll(/\bverdict\s*\(\s*["']RED["']/g)) {
      sites.push(site(relative, source, match, "verdict:RED"));
    }
  }
  sites.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column || a.spelling.localeCompare(b.spelling));
  const counts = {
    fail: sites.filter((entry) => entry.spelling === "fail").length,
    "verdict:RED": sites.filter((entry) => entry.spelling === "verdict:RED").length,
  };
  return {
    mechanism: "plain-regex-line-scan-v1-no-parser",
    sourceAggregate: sha256(filesUnder(absolute).map((file) => `${path.relative(absolute, file)}\0${fs.readFileSync(file)}`).join("\0")),
    aggregate: sha256(JSON.stringify(sites)),
    counts,
    sites,
  };
}
