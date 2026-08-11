import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parse } from "acorn";

export const CENSUS_SCHEMA = "N0_GUARD_CENSUS_V2";
export const SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function fail(code, detail) {
  const error = new Error(`${code}: ${detail}`);
  error.code = code;
  throw error;
}

function walk(node, visit, parent = null) {
  if (!node || typeof node !== "object") return;
  if (typeof node.type === "string") visit(node, parent);
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc" || key === "start" || key === "end") continue;
    if (Array.isArray(value)) {
      for (const child of value) walk(child, visit, node);
    } else if (value && typeof value === "object" && typeof value.type === "string") {
      walk(value, visit, node);
    }
  }
}

function contains(ancestor, descendant) {
  return ancestor.start <= descendant.start && ancestor.end >= descendant.end;
}

function calleeName(callee) {
  if (callee?.type === "Identifier") return callee.name;
  if (callee?.type === "MemberExpression" && callee.object?.type === "Identifier") {
    const property = !callee.computed && callee.property?.type === "Identifier"
      ? callee.property.name
      : literalString(callee.property);
    if (property) return `${callee.object.name}.${property}`;
  }
  return null;
}

function literalString(node) {
  return node?.type === "Literal" && typeof node.value === "string" ? node.value : null;
}

function atomicTerms(record, expression, atNode = expression, seen = new Set()) {
  if (!expression) return [];
  if (expression.type === "Identifier") {
    const binding = bindingFor(record, expression.name, atNode);
    if (binding?.kind === "const" && binding.init) {
      const key = `${binding.node.start}:${binding.node.end}`;
      if (seen.has(key)) fail("CENSUS_BINDING_CYCLE", `${record.relative}:${expression.name}`);
      return atomicTerms(record, binding.init, binding.node, new Set([...seen, key]));
    }
  }
  if (expression.type === "LogicalExpression") {
    return [...atomicTerms(record, expression.left, atNode, seen), ...atomicTerms(record, expression.right, atNode, seen)];
  }
  return [expression];
}

function sourceFiles(root) {
  const files = [];
  function visit(directory) {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) files.push(target);
      else if (entry.isSymbolicLink()) fail("CENSUS_SYMLINK", target);
    }
  }
  visit(root);
  return files;
}

function relativeImport(fromFile, specifier) {
  if (!specifier.startsWith(".")) return null;
  const candidate = path.resolve(path.dirname(fromFile), specifier);
  const options = path.extname(candidate) ? [candidate] : [...SOURCE_EXTENSIONS].map((ext) => `${candidate}${ext}`);
  return options.find((value) => fs.existsSync(value)) ?? candidate;
}

function functionName(node, parent) {
  if (node.type === "FunctionDeclaration" && node.id) return node.id.name;
  if ((node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression")
    && parent?.type === "VariableDeclarator" && parent.id?.type === "Identifier") return parent.id.name;
  return null;
}

function walkWithinFunction(fn, visit) {
  function descend(node, parent = null) {
    if (!node || typeof node !== "object") return;
    if (node !== fn.node && /Function/.test(node.type)) return;
    if (typeof node.type === "string") visit(node, parent);
    for (const [key, value] of Object.entries(node)) {
      if (key === "loc" || key === "start" || key === "end") continue;
      if (Array.isArray(value)) for (const child of value) descend(child, node);
      else if (value && typeof value === "object" && typeof value.type === "string") descend(value, node);
    }
  }
  descend(fn.node);
}

function enclosingFunction(node, functions) {
  let winner = null;
  for (const fn of functions) {
    if (contains(fn.node, node) && (!winner || fn.node.start > winner.node.start)) winner = fn;
  }
  return winner;
}

function bindingFor(record, name, atNode) {
  const owner = enclosingFunction(atNode, record.functions);
  const candidates = record.bindings.filter((binding) => {
    if (binding.name !== name || binding.node.start > atNode.start) return false;
    const bindingOwner = enclosingFunction(binding.node, record.functions);
    return bindingOwner?.key === owner?.key;
  });
  return candidates.sort((a, b) => b.node.start - a.node.start)[0] ?? null;
}

function resolveImmutableExpression(record, expression, atNode = expression, seen = new Set()) {
  if (expression?.type !== "Identifier") return expression;
  const binding = bindingFor(record, expression.name, atNode);
  if (!binding || binding.kind !== "const" || !binding.init) return expression;
  const key = `${binding.node.start}:${binding.node.end}`;
  if (seen.has(key)) fail("CENSUS_BINDING_CYCLE", `${record.relative}:${expression.name}`);
  seen.add(key);
  return resolveImmutableExpression(record, binding.init, binding.node, seen);
}

function returnedStatus(record, node) {
  if (node.type !== "ReturnStatement" || !node.argument) return null;
  const value = resolveImmutableExpression(record, node.argument, node);
  if (value?.type !== "ObjectExpression") return null;
  const statusProperty = value.properties.find((property) => property.type === "Property"
    && !property.computed && ((property.key.type === "Identifier" && property.key.name === "status")
      || literalString(property.key) === "status"));
  return { status: literalString(statusProperty?.value), value };
}

function rejectionEscapes(record, node) {
  let current = node;
  while (current) {
    const parent = record.parents.get(current);
    if (!parent) return true;
    if (parent.type === "TryStatement" && parent.handler && contains(parent.block, node)) {
      const last = parent.handler.body?.body?.at(-1);
      if (last?.type !== "ThrowStatement") return false;
    }
    if (/Function/.test(parent.type)) return true;
    current = parent;
  }
  return true;
}

function normalizedNodeSource(record, node) {
  return record.source.slice(node.start, node.end).replace(/\r\n/g, "\n").trim();
}

function stableNode(record, node, kind, extra = {}) {
  const source = normalizedNodeSource(record, node);
  const shortHash = sha256(source).slice(0, 16);
  const line = node.loc.start.line;
  const column = node.loc.start.column + 1;
  return {
    id: `${record.relative}:${line}:${column}:${kind}:${shortHash}`,
    kind,
    file: record.relative,
    line,
    column,
    nodeType: node.type,
    sourceHash: sha256(source),
    source,
    start: node.start,
    end: node.end,
    ...extra,
  };
}

function parseRecord(root, file) {
  const source = fs.readFileSync(file, "utf8");
  let ast;
  try {
    ast = parse(source, { ecmaVersion: "latest", sourceType: "module", locations: true });
  } catch (error) {
    fail("CENSUS_PARSE", `${path.relative(root, file)}:${error.loc?.line ?? "?"}:${error.loc?.column ?? "?"}: ${error.message}`);
  }
  const record = { root, file, relative: path.relative(root, file).split(path.sep).join("/"), source, ast, parents: new Map(), functions: [], imports: new Map(), bindings: [], nodes: [] };
  walk(ast, (node, parent) => {
    if (parent) record.parents.set(node, parent);
    const name = functionName(node, parent);
    if (name) record.functions.push({ key: `${file}#${name}`, name, file, node, record, directReject: false, rejects: false });
    if (node.type === "VariableDeclarator" && node.id?.type === "Identifier") {
      record.bindings.push({ name: node.id.name, init: node.init, node, declaration: parent, kind: parent?.kind ?? null });
    }
    if (node.type === "ImportDeclaration") {
      const importedFile = relativeImport(file, node.source.value);
      if (node.source.value.startsWith(".") && (!importedFile || !path.resolve(importedFile).startsWith(`${path.resolve(root)}${path.sep}`))) {
        fail("CENSUS_IMPORT_ESCAPE", `${record.relative}: ${node.source.value}`);
      }
      if (node.source.value.startsWith(".") && !fs.existsSync(importedFile)) fail("CENSUS_IMPORT_MISSING", `${record.relative}: ${node.source.value}`);
      for (const specifier of node.specifiers) {
        const imported = specifier.type === "ImportSpecifier" ? specifier.imported.name : "default";
        record.imports.set(specifier.local.name, { file: importedFile, name: imported });
      }
    }
    if (node.type === "ImportExpression") fail("CENSUS_DYNAMIC_IMPORT", record.relative);
  });
  return record;
}

function directOutcome(record, node, parent) {
  if (node.type === "ThrowStatement") return { outcome: "reject", spelling: "throw" };
  if (node.type === "AssignmentExpression" && calleeName(node.left) === "process.exitCode") return { outcome: "exit-status", spelling: "process.exitCode" };
  if (node.type === "ReturnStatement") {
    const returned = returnedStatus(record, node);
    if (node.argument?.type === "Identifier") {
      if (returned?.status === "N0_TEST_CAPABLE") return { outcome: "accept", spelling: "object:N0_TEST_CAPABLE" };
      if (returned?.status === "RED" || returned?.status === "BLOCKED") return { outcome: "reject", spelling: `object:${returned.status}` };
      return { outcome: "candidate", spelling: "returned-binding" };
    }
  }
  if (node.type === "ObjectExpression" && parent?.type === "ReturnStatement") {
    const statusProperty = node.properties.find((property) => property.type === "Property"
      && !property.computed && ((property.key.type === "Identifier" && property.key.name === "status")
        || literalString(property.key) === "status"));
    const status = literalString(statusProperty?.value);
    if (status === "N0_TEST_CAPABLE") return { outcome: "accept", spelling: "object:N0_TEST_CAPABLE" };
    if (status === "RED" || status === "BLOCKED") return { outcome: "reject", spelling: `object:${status}` };
  }
  if (node.type !== "CallExpression") return null;
  const name = calleeName(node.callee);
  if (name === "process.exit") return { outcome: "terminate", spelling: "process.exit" };
  if (["process.kill", "Promise.reject", "assert", "assert.ok"].includes(name)) return { outcome: "reject", spelling: name };
  if (name === "fail") return { outcome: "reject", spelling: "fail" };
  if (name === "verdict") {
    const status = literalString(node.arguments[0]);
    if (status === "N0_TEST_CAPABLE") return { outcome: "accept", spelling: "verdict" };
    if (status === "RED" || status === "BLOCKED") return { outcome: "reject", spelling: `verdict:${status}` };
    return { outcome: "dynamic", spelling: "verdict" };
  }
  if (name === null) return { outcome: "unresolved", spelling: "dynamic-callee" };
  return null;
}

function resolveFunction(recordsByFile, functionsByKey, record, localName) {
  const local = functionsByKey.get(`${record.file}#${localName}`);
  if (local) return local;
  const imported = record.imports.get(localName);
  if (!imported?.file) return null;
  const importedRecord = recordsByFile.get(imported.file);
  if (!importedRecord) return null;
  return functionsByKey.get(`${importedRecord.file}#${imported.name}`) ?? null;
}

function nearestRejectingIf(record, sinkNode) {
  let current = record.parents.get(sinkNode);
  while (current) {
    if (current.type === "IfStatement" && contains(current.consequent, sinkNode)) return current;
    if (/Function/.test(current.type)) return null;
    current = record.parents.get(current);
  }
  return null;
}

function callExpressions(expression) {
  const calls = [];
  walk(expression, (node) => {
    if (node.type === "CallExpression") calls.push(node);
  });
  return calls;
}

function isPureBuiltinCall(call) {
  const name = calleeName(call.callee);
  const method = call.callee?.type === "MemberExpression"
    ? (!call.callee.computed && call.callee.property?.type === "Identifier"
      ? call.callee.property.name : literalString(call.callee.property))
    : null;
  return ["Array.isArray", "Number.isFinite", "Number.isSafeInteger", "path.isAbsolute"].includes(name)
    || ["test", "includes", "startsWith", "endsWith", "some", "every", "isSymbolicLink", "isDirectory", "isFile"].includes(method);
}

function predicateExpressions(fn) {
  const expressions = [];
  walkWithinFunction(fn, (node) => {
    if (node.type === "ReturnStatement" && node.argument
      && !(node.argument.type === "Literal" && typeof node.argument.value === "boolean")) expressions.push(node.argument);
    if (node.type === "IfStatement") expressions.push(node.test);
  });
  return expressions;
}

function looksBoolean(record, expression, context, seen = new Set()) {
  if (!expression) return false;
  const resolved = resolveImmutableExpression(record, expression, expression);
  if (resolved !== expression) return looksBoolean(record, resolved, context, seen);
  if (expression.type === "Literal") return typeof expression.value === "boolean";
  if (expression.type === "UnaryExpression") return expression.operator === "!";
  if (expression.type === "BinaryExpression") return ["==", "!=", "===", "!==", "<", "<=", ">", ">=", "in", "instanceof"].includes(expression.operator);
  if (expression.type === "LogicalExpression") return looksBoolean(record, expression.left, context, seen) && looksBoolean(record, expression.right, context, seen);
  if (expression.type === "ConditionalExpression") return looksBoolean(record, expression.consequent, context, seen) && looksBoolean(record, expression.alternate, context, seen);
  if (expression.type === "CallExpression") {
    const name = calleeName(expression.callee);
    const method = expression.callee?.type === "MemberExpression" && !expression.callee.computed
      && expression.callee.property?.type === "Identifier" ? expression.callee.property.name : name?.split(".").at(-1);
    if (["Array.isArray", "Number.isFinite", "Number.isSafeInteger", "path.isAbsolute"].includes(name)
      || ["test", "includes", "startsWith", "endsWith", "some", "every", "isSymbolicLink", "isDirectory", "isFile"].includes(method)) return true;
    if (expression.callee.type !== "Identifier") return false;
    const target = resolveFunction(context.recordsByFile, context.functionsByKey, record, expression.callee.name);
    if (!target || seen.has(target.key)) return false;
    return functionReturnsBoolean(target, context, new Set([...seen, target.key]));
  }
  return false;
}

function functionReturnsBoolean(fn, context, seen = new Set([fn.key])) {
  const returns = [];
  walkWithinFunction(fn, (node) => {
    if (node.type === "ReturnStatement" && node.argument) returns.push(node.argument);
  });
  return returns.length > 0 && returns.every((expression) => looksBoolean(fn.record, expression, context, seen));
}

function predicateCallContext(record, call, outcomes) {
  let conditional = null;
  let current = call;
  while (current) {
    const parent = record.parents.get(current);
    if (!parent || /Function/.test(parent.type)) break;
    if (parent.type === "IfStatement" && contains(parent.test, call)) {
      conditional = parent;
      break;
    }
    current = parent;
  }
  if (!conditional) return "non-enforcing";
  const owner = enclosingFunction(call, record.functions);
  const branchRejects = (branch) => branch && outcomes.some((outcome) => outcome.record === record
    && ["reject", "terminate", "exit-status"].includes(outcome.outcome)
    && enclosingFunction(outcome.node, record.functions)?.key === owner?.key
    && contains(branch, outcome.node));
  const consequentRejects = branchRejects(conditional.consequent);
  const alternateRejects = branchRejects(conditional.alternate);
  if (!consequentRejects && !alternateRejects) return "non-enforcing";
  if (consequentRejects && alternateRejects) fail("CENSUS_PREDICATE_CONTEXT", `${record.relative}:${call.loc.start.line}: both branches reject`);

  let callTrueMakesTestTrue = true;
  current = call;
  while (current !== conditional.test) {
    const parent = record.parents.get(current);
    if (!parent) fail("CENSUS_PREDICATE_CONTEXT", `${record.relative}:${call.loc.start.line}: detached call`);
    if (parent.type === "UnaryExpression" && parent.operator === "!") callTrueMakesTestTrue = !callTrueMakesTestTrue;
    else if (parent.type !== "LogicalExpression") {
      fail("CENSUS_PREDICATE_CONTEXT", `${record.relative}:${call.loc.start.line}: unsupported ${parent.type}`);
    }
    current = parent;
  }
  const callTrueRejects = consequentRejects ? callTrueMakesTestTrue : !callTrueMakesTestTrue;
  return callTrueRejects ? "reject-on-true" : "reject-on-false";
}

function sharedContextPredicateProof(records, functions, outcomes, discovered, recordsByFile, functionsByKey, queuedPredicates) {
  const predicateFunctions = new Map(functions.filter((fn) => queuedPredicates.has(fn.key)).map((fn) => [fn.key, fn]));
  for (const record of records) {
    for (const binding of record.bindings) {
      if (binding.init?.type !== "Identifier") continue;
      const target = resolveFunction(recordsByFile, functionsByKey, record, binding.init.name);
      if (target && predicateFunctions.has(target.key)) {
        fail("CENSUS_PREDICATE_ALIAS", `${record.relative}:${binding.node.loc.start.line}:${binding.name}`);
      }
    }
  }

  const callsByPredicate = new Map([...predicateFunctions.keys()].map((key) => [key, []]));
  for (const record of records) {
    walk(record.ast, (node) => {
      if (node.type !== "CallExpression" || node.callee.type !== "Identifier") return;
      const target = resolveFunction(recordsByFile, functionsByKey, record, node.callee.name);
      if (!target || !predicateFunctions.has(target.key)) return;
      if (node.optional === true) {
        fail("CENSUS_PREDICATE_DYNAMIC_CALL", `${record.relative}:${node.loc.start.line}:${node.callee.name}`);
      }
      const context = predicateCallContext(record, node, outcomes);
      const guardOwners = discovered.filter((entry) => entry.kind === "guard-atom" && entry.file === record.relative
        && entry.start <= node.start && entry.end >= node.end)
        .sort((left, right) => (left.end - left.start) - (right.end - right.start));
      if (context !== "non-enforcing" && guardOwners.length === 0) {
        fail("CENSUS_SHARED_CONTEXT_CALL", `${record.relative}:${node.loc.start.line}: no enforcing guard owner`);
      }
      const callsite = stableNode(record, node, "predicate-call", {
        predicate: target.name,
        context,
        enforcingEntryId: context === "non-enforcing" ? null : guardOwners[0].id,
      });
      callsByPredicate.get(target.key).push(callsite);
    });
  }

  const proof = [];
  for (const [key, calls] of callsByPredicate) {
    const contexts = [...new Set(calls.map((call) => call.context))].sort();
    if (contexts.length < 2) continue;
    const fn = predicateFunctions.get(key);
    const atomIds = discovered.filter((entry) => entry.kind === "predicate-atom" && entry.predicate === fn.name)
      .map((entry) => entry.id).sort();
    if (atomIds.length === 0) fail("CENSUS_SHARED_CONTEXT_ATOMS", fn.name);
    proof.push({
      predicate: fn.name,
      functionKey: `${fn.record.relative}#${fn.name}`,
      contexts,
      atomIds,
      canonicalAtomMutations: atomIds.map((id) => ({
        id,
        mutation: { operator: "force-owned-condition", value: true },
      })),
      callSites: calls.map(({ id, file, line, column, sourceHash, source, context, enforcingEntryId }) => ({
        id, file, line, column, sourceHash, source, context, enforcingEntryId,
      })).sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line || left.column - right.column),
    });
  }
  return proof.sort((left, right) => left.functionKey.localeCompare(right.functionKey));
}

function sameCodeShadowProof(records, discovered) {
  const proof = [];
  for (const record of records) {
    walk(record.ast, (node) => {
      if (node.type !== "CallExpression" || node.optional === true
        || node.callee.type !== "Identifier" || node.callee.name !== "requireObject") return;
      const parent = record.parents.get(node);
      let statement;
      let validatedSource;
      if (parent?.type === "VariableDeclarator" && parent.init === node && parent.id?.type === "Identifier") {
        statement = record.parents.get(parent);
        validatedSource = parent.id.name;
        if (statement?.type !== "VariableDeclaration") return;
      } else if (parent?.type === "ExpressionStatement") {
        statement = parent;
        validatedSource = normalizedNodeSource(record, node.arguments[0]);
      } else {
        return;
      }
      const block = record.parents.get(statement);
      if (block?.type !== "BlockStatement") return;
      const index = block.body.indexOf(statement);
      const next = index >= 0 ? block.body[index + 1] : null;
      const downstream = next?.type === "ExpressionStatement" ? next.expression : null;
      if (downstream?.type !== "CallExpression" || downstream.optional === true
        || downstream.callee.type !== "Identifier" || downstream.callee.name !== "assertExactKeys"
        || normalizedNodeSource(record, downstream.arguments[0]) !== validatedSource) return;
      const upstreamCode = literalString(node.arguments[1]);
      const downstreamCode = literalString(downstream.arguments[2]);
      if (!upstreamCode || upstreamCode !== downstreamCode) return;
      const entry = discovered.find((candidate) => candidate.kind === "rejecting-helper-call"
        && candidate.file === record.relative && candidate.start === node.start && candidate.end === node.end);
      const downstreamEntry = discovered.find((candidate) => candidate.kind === "rejecting-helper-call"
        && candidate.file === record.relative && candidate.start === downstream.start && candidate.end === downstream.end);
      if (!entry || !downstreamEntry) fail("CENSUS_SHADOW_PROOF", `${record.relative}:${node.loc.start.line}`);
      proof.push({
        entryId: entry.id,
        downstreamEntryId: downstreamEntry.id,
        binding: validatedSource,
        rejectCode: upstreamCode,
        adjacencyHash: sha256(`${entry.sourceHash}:${downstreamEntry.sourceHash}`),
      });
    });
  }
  return proof.sort((left, right) => left.entryId.localeCompare(right.entryId));
}

function downstreamDomainShadowProof(records, functions, outcomes, discovered, recordsByFile, functionsByKey, queuedPredicates) {
  const proof = [];
  for (const fn of functions.filter((candidate) => queuedPredicates.has(candidate.key))) {
    const statements = fn.node.body?.type === "BlockStatement" ? fn.node.body.body : [];
    for (let index = 0; index + 1 < statements.length; index += 1) {
      const guard = statements[index];
      const returned = guard?.type === "IfStatement" && guard.alternate === null
        ? exactReturnStatement(guard.consequent) : null;
      if (!returned || returned.argument?.type !== "Literal" || returned.argument.value !== false
        || guard.test?.type !== "LogicalExpression" || guard.test.operator !== "||") continue;

      const downstreamTry = statements[index + 1];
      if (downstreamTry?.type !== "TryStatement" || downstreamTry.finalizer
        || downstreamTry.block?.body?.length !== 1 || downstreamTry.handler?.body?.body?.length !== 1) continue;
      const callStatement = downstreamTry.block.body[0];
      const call = callStatement?.type === "ExpressionStatement" ? callStatement.expression : null;
      const catchReturn = exactReturnStatement(downstreamTry.handler.body);
      if (call?.type !== "CallExpression" || call.optional === true || call.callee.type !== "Identifier"
        || !catchReturn || catchReturn.argument?.type !== "Literal" || catchReturn.argument.value !== false) continue;
      const target = resolveFunction(recordsByFile, functionsByKey, fn.record, call.callee.name);
      if (!target?.rejects) continue;
      const downstreamEntry = discovered.find((entry) => entry.kind === "rejecting-helper-call"
        && entry.file === fn.record.relative && entry.start === call.start && entry.end === call.end);
      if (!downstreamEntry) continue;

      const enforcingCalls = [];
      for (const record of records) {
        walk(record.ast, (node) => {
          if (node.type !== "CallExpression" || node.optional === true || node.callee.type !== "Identifier") return;
          const resolved = resolveFunction(recordsByFile, functionsByKey, record, node.callee.name);
          if (resolved?.key !== fn.key || predicateCallContext(record, node, outcomes) !== "reject-on-false") return;
          const owner = discovered.filter((entry) => entry.kind === "guard-atom" && entry.file === record.relative
            && entry.start <= node.start && entry.end >= node.end)
            .sort((left, right) => (left.end - left.start) - (right.end - right.start))[0];
          if (owner) enforcingCalls.push(owner.id);
        });
      }
      if (enforcingCalls.length === 0) continue;

      for (const atom of atomicTerms(fn.record, guard.test)) {
        const entry = discovered.find((candidate) => candidate.kind === "predicate-atom"
          && candidate.file === fn.record.relative && candidate.start === atom.start && candidate.end === atom.end);
        if (!entry) fail("CENSUS_DOWNSTREAM_DOMAIN_ATOM", `${fn.record.relative}:${atom.loc.start.line}`);
        const catchAnchor = {
          ...proofAnchor(fn.record, catchReturn, "downstream-domain-catch-return"),
          start: catchReturn.start,
          end: catchReturn.end,
        };
        proof.push({
          entryId: entry.id,
          predicate: fn.name,
          downstreamEntryId: downstreamEntry.id,
          enforcingEntryIds: [...new Set(enforcingCalls)].sort(),
          canonicalMutation: { operator: "force-owned-condition", value: false },
          catchReturn: catchAnchor,
          pathHash: sha256(`${entry.sourceHash}:${downstreamEntry.sourceHash}:${catchAnchor.sourceHash}`),
        });
      }
    }
  }
  return proof.sort((left, right) => left.entryId.localeCompare(right.entryId));
}

function enclosingConditionalTest(record, node) {
  let current = node;
  while (current) {
    const parent = record.parents.get(current);
    if (!parent || /Function/.test(parent.type)) return null;
    if (["IfStatement", "WhileStatement", "DoWhileStatement", "ConditionalExpression"].includes(parent.type)
      && contains(parent.test, node)) return parent;
    current = parent;
  }
  return null;
}

function generatedBinding(record, name, node, recordsByFile, functionsByKey) {
  let current = node;
  while (current) {
    const parent = record.parents.get(current);
    if (!parent) return false;
    if (/Function/.test(parent.type) && Array.isArray(parent.params)
      && parent.params.some((param) => param.type === "Identifier" && param.name === name)) {
      const call = record.parents.get(parent);
      const member = call?.type === "CallExpression" ? call.callee : null;
      const producer = member?.type === "MemberExpression" && !member.computed
        && member.property?.type === "Identifier" && member.property.name === "map"
        ? member.object : null;
      if (producer?.type !== "CallExpression" || producer.callee.type !== "Identifier") return false;
      const target = resolveFunction(recordsByFile, functionsByKey, record, producer.callee.name);
      return Boolean(target && !target.rejects && producer.arguments.length === 0);
    }
    if (parent.type === "ForOfStatement" && parent.left?.type === "VariableDeclaration"
      && parent.left.declarations.some((declaration) => declaration.id?.type === "Identifier" && declaration.id.name === name)) {
      const producer = parent.right;
      if (producer?.type !== "CallExpression" || producer.callee.type !== "Identifier") return false;
      const target = resolveFunction(recordsByFile, functionsByKey, record, producer.callee.name);
      return Boolean(target && !target.rejects && producer.arguments.length === 0);
    }
    current = parent;
  }
  return false;
}

function internallyConstructed(record, expression, atNode, owner, recordsByFile, functionsByKey, seen = new Set()) {
  if (!expression) return false;
  if (["Literal", "ObjectExpression", "ArrayExpression", "TemplateLiteral"].includes(expression.type)) return true;
  if (expression.type === "MemberExpression") return internallyConstructed(record, expression.object, atNode, owner, recordsByFile, functionsByKey, seen);
  if (expression.type !== "Identifier") return false;
  const binding = bindingFor(record, expression.name, atNode);
  if (binding && enclosingFunction(binding.node, record.functions)?.key === owner?.key) {
    const key = `${binding.node.start}:${binding.node.end}`;
    if (seen.has(key)) return false;
    if (binding.kind === "const" && binding.init) {
      return internallyConstructed(record, binding.init, binding.node, owner, recordsByFile, functionsByKey, new Set([...seen, key]));
    }
  }
  return generatedBinding(record, expression.name, atNode, recordsByFile, functionsByKey);
}

function callInsideDefault(record, call) {
  let current = call;
  while (current) {
    const parent = record.parents.get(current);
    if (!parent || /Function/.test(parent.type)) return false;
    if (parent.type === "AssignmentPattern" && contains(parent.right, call)) return true;
    current = parent;
  }
  return false;
}

function rejectionConfinedToDefaults(target, recordsByFile, functionsByKey) {
  if (target.directReject) return false;
  let sawRejectingCall = false;
  let confined = true;
  walkWithinFunction(target, (node) => {
    if (!confined || node.type !== "CallExpression" || node.callee.type !== "Identifier") return;
    const called = resolveFunction(recordsByFile, functionsByKey, target.record, node.callee.name);
    if (!called?.rejects) return;
    sawRejectingCall = true;
    if (!callInsideDefault(target.record, node)) confined = false;
  });
  return sawRejectingCall && confined;
}

function successPathCallProof(records, functions, discovered, recordsByFile, functionsByKey) {
  const proof = [];
  for (const record of records) {
    walk(record.ast, (node) => {
      if (node.type !== "CallExpression" || node.optional === true || node.callee.type !== "Identifier") return;
      const target = resolveFunction(recordsByFile, functionsByKey, record, node.callee.name);
      if (!target?.rejects) return;
      const entry = discovered.find((candidate) => candidate.kind === "rejecting-helper-call"
        && candidate.file === record.relative && candidate.start === node.start && candidate.end === node.end);
      if (!entry) return;
      const owner = enclosingFunction(node, record.functions);
      const conditional = enclosingConditionalTest(record, node);
      let proofKind = null;
      let dischargerEntryIds = [];
      if (!conditional && owner?.node.params.length === 0
        && node.arguments.every((argument) => internallyConstructed(record, argument, node, owner, recordsByFile, functionsByKey))) {
        proofKind = "closed-zero-parameter-construction";
      } else if (!conditional && callInsideDefault(record, node) && node.arguments.length === 0
        && target.node.params.length === 0) {
        proofKind = "closed-default-constructor";
      } else if (!conditional && rejectionConfinedToDefaults(target, recordsByFile, functionsByKey)
        && node.arguments.length >= target.node.params.length
        && node.arguments.every((argument) => argument.type !== "SpreadElement"
          && !(argument.type === "Identifier" && argument.name === "undefined"))) {
        proofKind = "supplied-argument-skips-rejecting-default";
      } else if (conditional && target.name === "renderPrompt" && owner?.name === "validateSpecimen") {
        let loop = node;
        while (loop && loop.type !== "ForOfStatement") loop = record.parents.get(loop);
        const earlierLoop = owner.node.body.body.find((statement) => statement.type === "ForOfStatement"
          && statement.end < loop?.start
          && normalizedNodeSource(record, statement.right) === normalizedNodeSource(record, loop.right));
        if (earlierLoop) {
          const token = /(?:cases|caseSpec|nonce|mailRowId|CASE_|REQUIRED_CASES)/;
          dischargerEntryIds = discovered.filter((candidate) => candidate.file === record.relative
            && candidate.start >= owner.node.start && candidate.end <= node.start
            && ["rejecting-helper-call", "guard-atom", "rejection-site"].includes(candidate.kind)
            && token.test(candidate.source))
            .map((candidate) => candidate.id).sort();
          if (dischargerEntryIds.length > 0) proofKind = "guard-call-dominated-by-owned-dischargers";
        }
      }
      if (!proofKind) return;
      proof.push({
        entryId: entry.id,
        proofKind,
        targetFunctionKey: `${target.record.relative}#${target.name}`,
        conditionalOwnerId: conditional
          ? discovered.find((candidate) => candidate.kind === "guard-atom" && candidate.file === record.relative
            && candidate.start <= node.start && candidate.end >= node.end)?.id ?? null
          : null,
        dischargerEntryIds,
      });
    });
  }
  return proof.sort((left, right) => left.entryId.localeCompare(right.entryId));
}

function exactReturnStatement(statement) {
  if (statement?.type === "ReturnStatement") return statement;
  if (statement?.type === "BlockStatement" && statement.body.length === 1
    && statement.body[0].type === "ReturnStatement") return statement.body[0];
  return null;
}

function proofAnchor(record, node, kind) {
  const anchor = stableNode(record, node, kind);
  return {
    id: anchor.id,
    file: anchor.file,
    line: anchor.line,
    column: anchor.column,
    nodeType: anchor.nodeType,
    sourceHash: anchor.sourceHash,
    source: anchor.source,
  };
}

function delegatedOutcomeCallProof(records, functions, outcomes, discovered, recordsByFile, functionsByKey) {
  const proof = [];
  for (const record of records) {
    walk(record.ast, (node) => {
      if (node.type !== "CallExpression" || node.optional === true || node.callee.type !== "Identifier") return;
      const target = resolveFunction(recordsByFile, functionsByKey, record, node.callee.name);
      if (!target?.rejects || target.directReject) return;
      const entry = discovered.find((candidate) => candidate.kind === "rejecting-helper-call"
        && candidate.file === record.relative && candidate.start === node.start && candidate.end === node.end);
      if (!entry) return;

      const declarator = record.parents.get(node);
      const declaration = declarator?.type === "VariableDeclarator" && declarator.init === node
        && declarator.id?.type === "Identifier" ? record.parents.get(declarator) : null;
      const block = declaration?.type === "VariableDeclaration" ? record.parents.get(declaration) : null;
      const statementIndex = block?.type === "BlockStatement" ? block.body.indexOf(declaration) : -1;
      const nullGuard = statementIndex >= 0 ? block.body[statementIndex + 1] : null;
      const controlFlow = nullGuard?.type === "IfStatement" && nullGuard.alternate === null
        && nullGuard.test?.type === "UnaryExpression" && nullGuard.test.operator === "!"
        && nullGuard.test.argument?.type === "Identifier"
        && nullGuard.test.argument.name === declarator.id.name
        ? exactReturnStatement(nullGuard.consequent) : null;
      if (!controlFlow || controlFlow.argument !== null) return;

      const targetDirectOutcomes = outcomes.filter((outcome) => outcome.record.file === target.record.file
        && enclosingFunction(outcome.node, target.record.functions)?.key === target.key
        && ["reject", "terminate", "exit-status"].includes(outcome.outcome));
      if (targetDirectOutcomes.length !== 0) return;

      const delegatedCalls = [];
      let unresolvedRejectingCall = false;
      walkWithinFunction(target, (candidate) => {
        if (candidate.type !== "CallExpression") return;
        if (candidate.callee.type !== "Identifier") return;
        const delegatedTarget = resolveFunction(recordsByFile, functionsByKey, target.record, candidate.callee.name);
        if (!delegatedTarget?.rejects) return;
        if (!delegatedTarget.directReject) {
          unresolvedRejectingCall = true;
          return;
        }
        const direct = outcomes.filter((outcome) => outcome.record.file === delegatedTarget.record.file
          && enclosingFunction(outcome.node, delegatedTarget.record.functions)?.key === delegatedTarget.key
          && ["reject", "terminate", "exit-status"].includes(outcome.outcome));
        if (direct.length === 0 || direct.some((outcome) => outcome.outcome !== "exit-status")) {
          unresolvedRejectingCall = true;
          return;
        }
        const callStatement = target.record.parents.get(candidate);
        const callBlock = callStatement?.type === "ExpressionStatement" ? target.record.parents.get(callStatement) : null;
        const callIndex = callBlock?.type === "BlockStatement" ? callBlock.body.indexOf(callStatement) : -1;
        const delegatedReturn = callIndex >= 0 ? exactReturnStatement(callBlock.body[callIndex + 1]) : null;
        if (!delegatedReturn || literalString(delegatedReturn.argument) !== null
          || delegatedReturn.argument?.type !== "Literal" || delegatedReturn.argument.value !== null) {
          unresolvedRejectingCall = true;
          return;
        }
        delegatedCalls.push({ candidate, direct });
      });
      if (unresolvedRejectingCall || delegatedCalls.length === 0) return;

      const internalCallEntryIds = delegatedCalls.map(({ candidate }) => discovered.find((item) =>
        item.kind === "rejecting-helper-call" && item.file === target.record.relative
        && item.start === candidate.start && item.end === candidate.end)?.id ?? null);
      const internalOutcomeEntryIds = delegatedCalls.flatMap(({ direct }) => direct.map((outcome) => discovered.find((item) =>
        item.file === outcome.record.relative && item.start === outcome.node.start && item.end === outcome.node.end
        && ["exit-status-site", "rejection-site"].includes(item.kind))?.id ?? null));
      if (internalCallEntryIds.some((id) => id === null) || internalOutcomeEntryIds.some((id) => id === null)) return;

      proof.push({
        entryId: entry.id,
        targetFunctionKey: `${target.record.relative}#${target.name}`,
        internalCallEntryIds: [...new Set(internalCallEntryIds)].sort(),
        internalOutcomeEntryIds: [...new Set(internalOutcomeEntryIds)].sort(),
        callerNullGuard: proofAnchor(record, nullGuard.test, "delegated-null-guard"),
        callerControlFlow: proofAnchor(record, controlFlow, "delegated-control-flow"),
      });
    });
  }
  return proof.sort((left, right) => left.entryId.localeCompare(right.entryId));
}

export function analyzeGuardGraph(root) {
  const absoluteRoot = path.resolve(root);
  const files = sourceFiles(absoluteRoot);
  const records = files.map((file) => parseRecord(absoluteRoot, file));
  const recordsByFile = new Map(records.map((record) => [record.file, record]));
  const functions = records.flatMap((record) => record.functions);
  const functionsByKey = new Map(functions.map((fn) => [fn.key, fn]));
  const analysisContext = { recordsByFile, functionsByKey };
  const outcomes = [];

  for (const record of records) {
    walk(record.ast, (node) => {
      const outcome = directOutcome(record, node, record.parents.get(node));
      if (!outcome) return;
      outcomes.push({ record, node, ...outcome });
      const fn = enclosingFunction(node, record.functions);
      if (fn && ["reject", "terminate", "exit-status"].includes(outcome.outcome) && rejectionEscapes(record, node)) fn.directReject = true;
    });
  }

  for (const fn of functions) fn.rejects = fn.directReject;
  let changed = true;
  while (changed) {
    changed = false;
    for (const fn of functions) {
      if (fn.rejects) continue;
      walkWithinFunction(fn, (node) => {
        if (node.type !== "CallExpression" || node.callee.type !== "Identifier") return;
        const target = resolveFunction(recordsByFile, functionsByKey, fn.record, node.callee.name);
        if (target?.rejects && rejectionEscapes(fn.record, node)) fn.rejects = true;
      });
      if (fn.rejects) changed = true;
    }
  }

  for (const record of records) {
    for (const binding of record.bindings) {
      if (binding.init?.type !== "Identifier") continue;
      const target = resolveFunction(recordsByFile, functionsByKey, record, binding.init.name);
      if (target?.rejects || binding.init.name === "fail") {
        fail("CENSUS_REJECT_ALIAS", `${record.relative}:${binding.node.loc.start.line}:${binding.name}`);
      }
    }
  }

  const discovered = [];
  const predicateQueue = [];
  const queuedPredicates = new Set();
  for (const outcome of outcomes) {
    const kind = outcome.outcome === "accept" ? "success-constructor"
      : outcome.outcome === "terminate" ? "termination-site"
        : outcome.outcome === "exit-status" ? "exit-status-site"
          : outcome.outcome === "dynamic" ? "dynamic-verdict-constructor"
            : outcome.outcome === "candidate" ? "outcome-candidate"
              : outcome.outcome === "unresolved" ? "unresolved-call" : "rejection-site";
    const guard = nearestRejectingIf(outcome.record, outcome.node);
    const owner = enclosingFunction(outcome.node, outcome.record.functions);
    const ownership = guard ? `if:${guard.loc.start.line}` : owner ? `helper-body:${owner.name}` : "module-body";
    discovered.push(stableNode(outcome.record, outcome.node, kind, { spelling: outcome.spelling, ownership }));
    if (!["reject", "terminate", "exit-status"].includes(outcome.outcome)) continue;
    if (!guard) continue;
    const guardAtoms = atomicTerms(outcome.record, guard.test);
    for (const atom of guardAtoms) {
      discovered.push(stableNode(outcome.record, atom, "guard-atom", { ownerSinkLine: outcome.node.loc.start.line }));
    }
    for (const call of guardAtoms.flatMap((atom) => callExpressions(atom))) {
      const name = call.callee.type === "Identifier" ? call.callee.name : null;
      const target = name ? resolveFunction(recordsByFile, functionsByKey, outcome.record, name) : null;
      if (target && functionReturnsBoolean(target, analysisContext) && !queuedPredicates.has(target.key)) {
        queuedPredicates.add(target.key);
        predicateQueue.push(target);
      } else if (!isPureBuiltinCall(call)) {
        discovered.push(stableNode(outcome.record, call, "unresolved-call", { context: "guard", callee: calleeName(call.callee) }));
      }
    }
  }

  while (predicateQueue.length) {
    const fn = predicateQueue.shift();
    for (const expression of predicateExpressions(fn)) {
      const predicateAtoms = atomicTerms(fn.record, expression);
      for (const atom of predicateAtoms) {
        discovered.push(stableNode(fn.record, atom, "predicate-atom", { predicate: fn.name }));
      }
      for (const call of predicateAtoms.flatMap((atom) => callExpressions(atom))) {
        const name = call.callee.type === "Identifier" ? call.callee.name : null;
        const target = name ? resolveFunction(recordsByFile, functionsByKey, fn.record, name) : null;
        if (target && functionReturnsBoolean(target, analysisContext) && !queuedPredicates.has(target.key)) {
          queuedPredicates.add(target.key);
          predicateQueue.push(target);
        } else if (!isPureBuiltinCall(call)) {
          discovered.push(stableNode(fn.record, call, "unresolved-call", { context: "predicate", callee: calleeName(call.callee) }));
        }
      }
    }
  }

  for (const record of records) {
    walk(record.ast, (node) => {
      if (node.type !== "CallExpression" || node.callee.type !== "Identifier") return;
      const target = resolveFunction(recordsByFile, functionsByKey, record, node.callee.name);
      if (!target?.rejects || node.callee.name === "fail") return;
      discovered.push(stableNode(record, node, "rejecting-helper-call", { helper: target.name }));
      const guard = nearestRejectingIf(record, node);
      const owner = enclosingFunction(node, record.functions);
      if (guard && !guard.alternate && target.key !== owner?.key) {
        for (const atom of atomicTerms(record, guard.test)) {
          discovered.push(stableNode(record, atom, "guard-atom", { ownerSinkLine: node.loc.start.line }));
        }
      }
    });
  }

  const byId = new Map();
  for (const entry of discovered) {
    if (byId.has(entry.id)) continue;
    byId.set(entry.id, entry);
  }
  const entries = [...byId.values()].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column || a.kind.localeCompare(b.kind));
  const counts = Object.fromEntries([...new Set(entries.map((entry) => entry.kind))].sort().map((kind) => [kind, entries.filter((entry) => entry.kind === kind).length]));
  const sharedContextPredicates = sharedContextPredicateProof(
    records, functions, outcomes, entries, recordsByFile, functionsByKey, queuedPredicates,
  );
  const sameCodeShadows = sameCodeShadowProof(records, entries);
  const downstreamDomainShadows = downstreamDomainShadowProof(
    records, functions, outcomes, entries, recordsByFile, functionsByKey, queuedPredicates,
  );
  const successPathCalls = successPathCallProof(records, functions, entries, recordsByFile, functionsByKey);
  const delegatedOutcomeCalls = delegatedOutcomeCallProof(records, functions, outcomes, entries, recordsByFile, functionsByKey);
  return { schema: CENSUS_SCHEMA, sourceRoot: path.basename(absoluteRoot), files: records.map((record) => record.relative), counts, sharedContextPredicates, sameCodeShadows, downstreamDomainShadows, successPathCalls, delegatedOutcomeCalls, entries };
}

function identity(entry) {
  const { id, kind, file, line, column, nodeType, sourceHash, source, spelling, ownership, ownerSinkLine, predicate, helper, context, callee } = entry;
  return { id, kind, file, line, column, nodeType, sourceHash, source, spelling, ownership, ownerSinkLine, predicate, helper, context, callee };
}

function migrationKey(entry) {
  return JSON.stringify({
    file: entry.file,
    kind: entry.kind,
    sourceHash: entry.sourceHash,
    spelling: entry.spelling,
    helper: entry.helper,
    predicate: entry.predicate,
    context: entry.context,
    callee: entry.callee,
  });
}

function migratedOwners(graph, prior) {
  const exact = new Map((prior?.entries ?? []).map((entry) => [entry.id, entry]));
  const buckets = new Map();
  for (const entry of prior?.entries ?? []) {
    const key = migrationKey(entry);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(entry);
  }
  for (const entries of buckets.values()) entries.sort((a, b) => a.line - b.line || a.column - b.column);
  return graph.entries.map((entry) => exact.get(entry.id) ?? buckets.get(migrationKey(entry))?.shift() ?? null);
}

export function mergeManifest(graph, prior = null, projection = null, counterexamples = null) {
  const migrated = migratedOwners(graph, prior);
  const sinkProjection = graph.entries.filter((entry) => entry.kind === "rejection-site"
    && (entry.spelling === "fail" || entry.spelling === "verdict:RED"));
  const priorFloors = prior?.floors?.counts ?? {};
  const floorKinds = [...new Set([...Object.keys(priorFloors), ...Object.keys(graph.counts)])].sort();
  const floors = Object.fromEntries(floorKinds.map((kind) => [
    kind,
    Math.max(graph.counts[kind] ?? 0, priorFloors[kind] ?? 0),
  ]));
  const priorDispositionCeiling = prior?.floors?.maxRedundancyDispositions;
  return {
    schema: CENSUS_SCHEMA,
    sourceRoot: graph.sourceRoot,
    baseline: {
      currentSinkProjection: sinkProjection.length,
      analyzerCounts: {
        fail: sinkProjection.filter((entry) => entry.spelling === "fail").length,
        "verdict:RED": sinkProjection.filter((entry) => entry.spelling === "verdict:RED").length,
      },
      independentProjection: projection,
      counterexampleUniverse: counterexamples,
      sharedContextPredicates: graph.sharedContextPredicates,
      sameCodeShadows: graph.sameCodeShadows,
      downstreamDomainShadows: graph.downstreamDomainShadows,
      successPathCalls: graph.successPathCalls,
      delegatedOutcomeCalls: graph.delegatedOutcomeCalls,
    },
    floors: {
      counts: floors,
      maxRedundancyDispositions: priorDispositionCeiling ?? 0,
      redundancyDispositionReason: prior?.floors?.redundancyDispositionReason ?? null,
      ownershipCounts: prior?.floors?.ownershipCounts ?? null,
      ownershipGrowthReasons: prior?.floors?.ownershipGrowthReasons ?? null,
      sharedContextPredicateAtoms: prior?.floors?.sharedContextPredicateAtoms ?? null,
      sameCodeShadowEntries: prior?.floors?.sameCodeShadowEntries ?? null,
      downstreamDomainShadowEntries: prior?.floors?.downstreamDomainShadowEntries ?? null,
      successPathCalls: prior?.floors?.successPathCalls ?? null,
      delegatedOutcomeCalls: prior?.floors?.delegatedOutcomeCalls ?? null,
      compoundDispositionUnits: prior?.floors?.compoundDispositionUnits ?? null,
      compoundDispositionMembers: prior?.floors?.compoundDispositionMembers ?? null,
    },
    compounds: prior?.compounds ?? [],
    counts: graph.counts,
    entries: graph.entries.map((entry, index) => ({
      ...identity(entry),
      mutation: migrated[index]?.mutation ?? null,
      witness: migrated[index]?.witness ?? null,
      acceptFlipSet: migrated[index]?.acceptFlipSet ?? null,
      rejectDeltaSet: migrated[index]?.rejectDeltaSet ?? null,
      positiveRegressionSet: migrated[index]?.positiveRegressionSet ?? null,
      disposition: migrated[index]?.disposition ?? null,
      classification: migrated[index]?.classification ?? null,
      ownershipRecord: migrated[index]?.ownershipRecord ?? null,
    })),
  };
}

function validateMutationShape(entry) {
  const mutation = entry.mutation;
  if (!mutation) return;
  const keys = Object.keys(mutation).sort().join(",");
  if (["suppress-thrown-rejection", "force-call-result-status"].includes(mutation.operator)
    && keys === "operator") return;
  if (mutation.operator === "bypass-rejection" && keys === "operator") return;
  if (mutation.operator === "force-owned-condition" && keys === "operator,value" && typeof mutation.value === "boolean") return;
  if (mutation.operator === "sanitize-first-binding" && keys === "binding,operator,value"
    && typeof mutation.binding === "string" && mutation.binding.length > 0
    && typeof mutation.value === "string" && mutation.value.length > 0) return;
  if (mutation.operator === "sanitize-first-argument" && keys === "operator,value"
    && typeof mutation.value === "string" && mutation.value.length > 0) return;
  if (mutation.operator === "drop-reviewed-property" && keys === "operator,target"
    && typeof mutation.target === "string" && mutation.target.length > 0) return;
  fail("CENSUS_MUTATION_OPERATOR", `${entry.id}: ${mutation.operator ?? "missing"}`);
}

const MUTATION_OWNERSHIP_KINDS = new Set([
  "normal-ownership",
  "reject-preserving-ownership",
  "mixed-ownership",
]);

function sortedUniqueById(items) {
  return Array.isArray(items)
    && new Set(items.map((item) => item?.id)).size === items.length
    && items.every((item) => typeof item?.id === "string" && item.id.length > 0)
    && JSON.stringify([...items].sort((left, right) => left.id.localeCompare(right.id))) === JSON.stringify(items);
}

function validateMutationOwnership(entry) {
  const accept = entry.acceptFlipSet;
  const reject = entry.rejectDeltaSet;
  const regressions = entry.positiveRegressionSet;
  const kind = entry.ownershipRecord?.kind;
  if (!MUTATION_OWNERSHIP_KINDS.has(kind)
    || !sortedUniqueById(accept)
    || !sortedUniqueById(reject)
    || !Array.isArray(regressions)
    || regressions.length !== 0) {
    fail("CENSUS_MUTATION_OWNERSHIP", entry.id);
  }
  if (accept.some((item) => typeof item.rejectCode !== "string" || typeof item.acceptCode !== "string")
    || reject.some((item) => !item.before || !item.after
      || typeof item.before.code !== "string" || typeof item.after.code !== "string")) {
    fail("CENSUS_MUTATION_PARTITION", entry.id);
  }
  const expectedKind = accept.length > 0 && reject.length > 0
    ? "mixed-ownership"
    : accept.length > 0
      ? "normal-ownership"
      : reject.length > 0
        ? "reject-preserving-ownership"
        : null;
  if (kind !== expectedKind) fail("CENSUS_MUTATION_OWNERSHIP", `${entry.id}: ${kind} != ${expectedKind}`);
  const partition = entry.witness?.partition;
  const expectedWitness = partition === "acceptFlipSet" && accept.length > 0
    ? { partition: "acceptFlipSet", ...accept[0] }
    : partition === "rejectDeltaSet" && reject.length > 0
      ? {
          partition: "rejectDeltaSet",
          id: reject[0].id,
          beforeCode: reject[0].before.code,
          afterCode: reject[0].after.code,
        }
      : null;
  if (JSON.stringify(entry.witness) !== JSON.stringify(expectedWitness)) fail("CENSUS_MUTATION_WITNESS", entry.id);
}

export function validateManifest(graph, manifest, {
  requirePairs = true,
  requireBaseline = true,
  projection = null,
  counterexamples = null,
} = {}) {
  if (manifest?.schema !== CENSUS_SCHEMA) fail("CENSUS_SCHEMA", "manifest schema mismatch");
  const actual = new Map(graph.entries.map((entry) => [entry.id, identity(entry)]));
  const owners = new Map();
  for (const entry of manifest.entries ?? []) {
    if (owners.has(entry.id)) fail("CENSUS_DUPLICATE_OWNER", entry.id);
    owners.set(entry.id, entry);
  }
  for (const [id, entry] of actual) {
    const owner = owners.get(id);
    if (!owner) fail("CENSUS_UNOWNED_NODE", id);
    if (JSON.stringify(identity(owner)) !== JSON.stringify(entry)) fail("CENSUS_STALE_ANCHOR", id);
    if (["unresolved-call", "outcome-candidate"].includes(owner.kind)) {
      if (requirePairs && (!["non-predicate", "non-outcome", "sink-candidate"].includes(owner.classification?.kind)
        || !owner.classification?.reason)) fail("CENSUS_CLOSED_BUCKET_UNOWNED", id);
      continue;
    }
    if (owner.kind === "success-constructor") {
      if (requirePairs && (owner.ownershipRecord?.kind !== "owned-success" || owner.mutation || owner.disposition)) fail("CENSUS_SUCCESS_OWNERSHIP", id);
      continue;
    }
    if (owner.ownershipRecord?.kind === "same-code-shadow") {
      const proof = manifest.baseline?.sameCodeShadows?.find((item) => item.entryId === owner.id);
      const record = owner.ownershipRecord;
      if (owner.kind !== "rejecting-helper-call" || owner.mutation || owner.disposition
        || !proof || record.downstreamEntryId !== proof.downstreamEntryId
        || record.rejectCode !== proof.rejectCode
        || record.canonicalMutation?.operator !== "suppress-thrown-rejection"
        || Object.keys(record.canonicalMutation).join(",") !== "operator"
        || typeof record.witnessId !== "string" || record.witnessId.length === 0) {
        fail("CENSUS_SAME_CODE_SHADOW", id);
      }
      continue;
    }
    if (owner.ownershipRecord?.kind === "compound-member") {
      if (owner.mutation || owner.disposition || typeof owner.ownershipRecord.compoundId !== "string") {
        fail("CENSUS_COMPOUND_MEMBER", id);
      }
      continue;
    }
    if (owner.ownershipRecord?.kind === "success-path-call") {
      const proof = manifest.baseline?.successPathCalls?.find((item) => item.entryId === owner.id);
      if (owner.kind !== "rejecting-helper-call" || owner.mutation || owner.disposition
        || !proof || owner.ownershipRecord.proofKind !== proof.proofKind
        || JSON.stringify(owner.ownershipRecord.dischargerEntryIds) !== JSON.stringify(proof.dischargerEntryIds)) {
        fail("CENSUS_SUCCESS_PATH_CALL", id);
      }
      continue;
    }
    if (owner.ownershipRecord?.kind === "delegated-outcome-call") {
      const proof = manifest.baseline?.delegatedOutcomeCalls?.find((item) => item.entryId === owner.id);
      const record = owner.ownershipRecord;
      if (owner.kind !== "rejecting-helper-call" || owner.mutation || owner.disposition || !proof
        || JSON.stringify(record.internalCallEntryIds) !== JSON.stringify(proof.internalCallEntryIds)
        || JSON.stringify(record.internalOutcomeEntryIds) !== JSON.stringify(proof.internalOutcomeEntryIds)
        || JSON.stringify(record.callerNullGuardOwnership) !== JSON.stringify(proof.callerNullGuard)
        || JSON.stringify(record.callerControlFlowOwnership) !== JSON.stringify(proof.callerControlFlow)) {
        fail("CENSUS_DELEGATED_OUTCOME_CALL", id);
      }
      continue;
    }
    if (owner.ownershipRecord?.kind === "shared-context-predicate") {
      const proof = manifest.baseline?.sharedContextPredicates?.find((item) => item.predicate === owner.predicate);
      const canonicalMutation = owner.ownershipRecord?.canonicalMutation;
      const provedMutation = proof?.canonicalAtomMutations?.find((item) => item.id === owner.id)?.mutation;
      if (owner.kind !== "predicate-atom" || owner.mutation || owner.disposition
        || !proof?.atomIds?.includes(owner.id)
        || JSON.stringify(canonicalMutation) !== JSON.stringify(provedMutation)) {
        fail("CENSUS_SHARED_CONTEXT_OWNERSHIP", id);
      }
      continue;
    }
    if (owner.ownershipRecord?.kind === "downstream-domain-shadow") {
      const proof = manifest.baseline?.downstreamDomainShadows?.find((item) => item.entryId === owner.id);
      const record = owner.ownershipRecord;
      if (owner.kind !== "predicate-atom" || owner.mutation || owner.disposition || !proof
        || record.downstreamEntryId !== proof.downstreamEntryId
        || typeof record.witnessId !== "string" || record.witnessId.length === 0
        || record.pathHash !== proof.pathHash
        || JSON.stringify(record.canonicalMutation) !== JSON.stringify(proof.canonicalMutation)
        || JSON.stringify(record.catchReturn) !== JSON.stringify(proof.catchReturn)
        || JSON.stringify(record.enforcingEntryIds) !== JSON.stringify(proof.enforcingEntryIds)) {
        fail("CENSUS_DOWNSTREAM_DOMAIN_OWNERSHIP", id);
      }
      continue;
    }
    if (owner.mutation?.kind === "structural-only") fail("CENSUS_STRUCTURAL_ONLY", id);
    validateMutationShape(owner);
    const mutable = owner.mutation && MUTATION_OWNERSHIP_KINDS.has(owner.ownershipRecord?.kind);
    const disposed = owner.disposition?.kind === "not-independently-discriminated"
      && owner.disposition?.witness && Array.isArray(owner.disposition?.coveredBy);
    if (requirePairs && Number(Boolean(mutable)) + Number(Boolean(disposed)) !== 1) fail("CENSUS_PAIR_MISSING", id);
    if (mutable) validateMutationOwnership(owner);
  }
  for (const id of owners.keys()) if (!actual.has(id)) fail("CENSUS_UNMATCHED_OWNER", id);
  const compounds = manifest.compounds;
  if (!Array.isArray(compounds)) fail("CENSUS_COMPOUNDS", "missing compounds array");
  const compoundIds = new Set();
  const compoundMemberIds = new Set();
  for (const compound of compounds) {
    if (typeof compound?.id !== "string" || compound.id.length === 0 || compoundIds.has(compound.id)
      || !Array.isArray(compound.memberIds) || compound.memberIds.length === 0
      || new Set(compound.memberIds).size !== compound.memberIds.length
      || !Array.isArray(compound.edits) || compound.edits.length < 2
      || new Set(compound.edits.map((edit) => edit?.entryId)).size !== compound.edits.length
      || typeof compound.witness?.id !== "string" || typeof compound.witness?.rejectCode !== "string"
      || typeof compound.witness?.acceptCode !== "string") {
      fail("CENSUS_COMPOUND_SHAPE", compound?.id ?? "missing");
    }
    compoundIds.add(compound.id);
    for (const memberId of compound.memberIds) {
      const member = owners.get(memberId);
      if (!member || compoundMemberIds.has(memberId)
        || member.ownershipRecord?.kind !== "compound-member"
        || member.ownershipRecord.compoundId !== compound.id) {
        fail("CENSUS_COMPOUND_MEMBER", `${compound.id}:${memberId}`);
      }
      compoundMemberIds.add(memberId);
    }
    for (const edit of compound.edits) {
      const target = owners.get(edit.entryId);
      if (!target || ["success-constructor", "unresolved-call", "outcome-candidate"].includes(target.kind)) {
        fail("CENSUS_COMPOUND_EDIT", `${compound.id}:${edit.entryId}`);
      }
      validateMutationShape({ ...target, mutation: edit.mutation });
    }
    if (!compound.memberIds.every((id) => compound.edits.some((edit) => edit.entryId === id))) {
      fail("CENSUS_COMPOUND_EDIT", `${compound.id}: member lacks edit`);
    }
  }
  for (const owner of owners.values()) {
    if (owner.ownershipRecord?.kind === "compound-member" && !compoundMemberIds.has(owner.id)) {
      fail("CENSUS_COMPOUND_MEMBER", `${owner.id}: dangling`);
    }
  }
  const dispositionEdges = new Map();
  for (const entry of owners.values()) {
    if (entry.disposition?.kind !== "not-independently-discriminated") continue;
    if (entry.disposition.coveredBy.length === 0 || new Set(entry.disposition.coveredBy).size !== entry.disposition.coveredBy.length) {
      fail("CENSUS_DISPOSITION_COVER", entry.id);
    }
    for (const covered of entry.disposition.coveredBy) {
      const target = owners.get(covered);
      if (!target || covered === entry.id || ["success-constructor", "unresolved-call", "outcome-candidate"].includes(target.kind)) {
        fail("CENSUS_DISPOSITION_COVER", `${entry.id}->${covered}`);
      }
    }
    dispositionEdges.set(entry.id, entry.disposition.coveredBy.filter((id) => owners.get(id)?.disposition));
  }
  const visitDisposition = (id, stack = new Set()) => {
    if (stack.has(id)) fail("CENSUS_DISPOSITION_CYCLE", id);
    for (const next of dispositionEdges.get(id) ?? []) visitDisposition(next, new Set([...stack, id]));
  };
  for (const id of dispositionEdges.keys()) visitDisposition(id);
  if ((graph.counts["success-constructor"] ?? 0) !== 1) fail("CENSUS_SUCCESS_COUNT", String(graph.counts["success-constructor"] ?? 0));
  for (const [kind, floor] of Object.entries(manifest.floors?.counts ?? {})) {
    if ((graph.counts[kind] ?? 0) < floor) fail("CENSUS_COUNT_REGRESSION", `${kind}: current=${graph.counts[kind] ?? 0} floor=${floor}`);
  }
  const dispositions = (manifest.entries ?? []).filter((entry) => entry.disposition?.kind === "not-independently-discriminated").length;
  const dispositionCeiling = manifest.floors?.maxRedundancyDispositions;
  if (!Number.isSafeInteger(dispositionCeiling) || dispositionCeiling < 0 || dispositions > dispositionCeiling) {
    fail("CENSUS_DISPOSITION_GROWTH", `current=${dispositions} ceiling=${dispositionCeiling}`);
  }
  if (dispositionCeiling > 0 && !manifest.floors?.redundancyDispositionReason) fail("CENSUS_DISPOSITION_REASON", "missing reviewed reason");
  if (requirePairs) {
    const compoundUnitFloor = manifest.floors?.compoundDispositionUnits;
    if ((compounds.length > 0 || compoundUnitFloor != null)
      && (!Number.isSafeInteger(compoundUnitFloor) || compoundUnitFloor < 0 || compounds.length !== compoundUnitFloor)) {
      fail("CENSUS_COMPOUND_UNIT_COUNT", `current=${compounds.length} floor=${compoundUnitFloor}`);
    }
    const sharedOwners = manifest.entries.filter((entry) => entry.ownershipRecord?.kind === "shared-context-predicate");
    const sharedFloor = manifest.floors?.sharedContextPredicateAtoms;
    if (!Number.isSafeInteger(sharedFloor) || sharedFloor < 0 || sharedOwners.length !== sharedFloor) {
      fail("CENSUS_SHARED_CONTEXT_COUNT", `current=${sharedOwners.length} floor=${sharedFloor}`);
    }
    for (const proof of manifest.baseline?.sharedContextPredicates ?? []) {
      for (const callsite of proof.callSites.filter((item) => item.context !== "non-enforcing")) {
        const owner = owners.get(callsite.enforcingEntryId);
        const independentlyOwned = MUTATION_OWNERSHIP_KINDS.has(owner?.ownershipRecord?.kind)
          || owner?.disposition?.kind === "not-independently-discriminated";
        if (!independentlyOwned) fail("CENSUS_SHARED_CONTEXT_ENFORCEMENT", `${proof.predicate}:${callsite.id}`);
      }
    }
    const shadowOwners = manifest.entries.filter((entry) => entry.ownershipRecord?.kind === "same-code-shadow");
    const shadowFloor = manifest.floors?.sameCodeShadowEntries;
    if (!Number.isSafeInteger(shadowFloor) || shadowFloor < 0 || shadowOwners.length !== shadowFloor) {
      fail("CENSUS_SAME_CODE_SHADOW_COUNT", `current=${shadowOwners.length} floor=${shadowFloor}`);
    }
    for (const owner of shadowOwners) {
      const downstreamId = owner.ownershipRecord.downstreamEntryId;
      const downstream = owners.get(downstreamId);
      const independentlyOwned = MUTATION_OWNERSHIP_KINDS.has(downstream?.ownershipRecord?.kind)
        || downstream?.ownershipRecord?.kind === "compound-member"
        || downstream?.disposition?.kind === "not-independently-discriminated";
      if (!independentlyOwned) fail("CENSUS_SAME_CODE_SHADOW_COVER", `${owner.id}->${downstreamId}`);
    }
    const compoundMembers = manifest.entries.filter((entry) => entry.ownershipRecord?.kind === "compound-member");
    const compoundFloor = manifest.floors?.compoundDispositionMembers;
    if (!Number.isSafeInteger(compoundFloor) || compoundFloor < 0 || compoundMembers.length !== compoundFloor) {
      fail("CENSUS_COMPOUND_COUNT", `current=${compoundMembers.length} floor=${compoundFloor}`);
    }
    const downstreamDomainOwners = manifest.entries.filter((entry) => entry.ownershipRecord?.kind === "downstream-domain-shadow");
    const downstreamDomainFloor = manifest.floors?.downstreamDomainShadowEntries;
    if (((manifest.baseline?.downstreamDomainShadows?.length ?? 0) > 0 || downstreamDomainFloor != null)
      && (!Number.isSafeInteger(downstreamDomainFloor) || downstreamDomainFloor < 0
        || downstreamDomainOwners.length !== downstreamDomainFloor)) {
      fail("CENSUS_DOWNSTREAM_DOMAIN_COUNT", `current=${downstreamDomainOwners.length} floor=${downstreamDomainFloor}`);
    }
    for (const owner of downstreamDomainOwners) {
      const downstream = owners.get(owner.ownershipRecord.downstreamEntryId);
      const independentlyOwned = MUTATION_OWNERSHIP_KINDS.has(downstream?.ownershipRecord?.kind)
        || downstream?.ownershipRecord?.kind === "compound-member"
        || downstream?.disposition?.kind === "not-independently-discriminated";
      if (!independentlyOwned) fail("CENSUS_DOWNSTREAM_DOMAIN_COVER", `${owner.id}->${owner.ownershipRecord.downstreamEntryId}`);
    }
    const successPathOwners = manifest.entries.filter((entry) => entry.ownershipRecord?.kind === "success-path-call");
    const successPathFloor = manifest.floors?.successPathCalls;
    if (!Number.isSafeInteger(successPathFloor) || successPathFloor < 0 || successPathOwners.length !== successPathFloor) {
      fail("CENSUS_SUCCESS_PATH_CALL_COUNT", `current=${successPathOwners.length} floor=${successPathFloor}`);
    }
    for (const owner of successPathOwners) {
      const proof = manifest.baseline.successPathCalls.find((item) => item.entryId === owner.id);
      const requiredIds = [...proof.dischargerEntryIds, ...(proof.conditionalOwnerId ? [proof.conditionalOwnerId] : [])];
      for (const requiredId of requiredIds) {
        const required = owners.get(requiredId);
        const independentlyOwned = MUTATION_OWNERSHIP_KINDS.has(required?.ownershipRecord?.kind)
          || required?.ownershipRecord?.kind === "compound-member"
          || required?.ownershipRecord?.kind === "same-code-shadow"
          || required?.disposition?.kind === "not-independently-discriminated";
        if (!independentlyOwned) fail("CENSUS_SUCCESS_PATH_DISCHARGER", `${owner.id}->${requiredId}`);
      }
    }
    const delegatedOwners = manifest.entries.filter((entry) => entry.ownershipRecord?.kind === "delegated-outcome-call");
    const delegatedFloor = manifest.floors?.delegatedOutcomeCalls;
    if (!Number.isSafeInteger(delegatedFloor) || delegatedFloor < 0 || delegatedOwners.length !== delegatedFloor) {
      fail("CENSUS_DELEGATED_OUTCOME_COUNT", `current=${delegatedOwners.length} floor=${delegatedFloor}`);
    }
    for (const owner of delegatedOwners) {
      const proof = manifest.baseline.delegatedOutcomeCalls.find((item) => item.entryId === owner.id);
      for (const requiredId of [...proof.internalCallEntryIds, ...proof.internalOutcomeEntryIds]) {
        const required = owners.get(requiredId);
        const independentlyOwned = MUTATION_OWNERSHIP_KINDS.has(required?.ownershipRecord?.kind)
          || required?.ownershipRecord?.kind === "compound-member"
          || required?.ownershipRecord?.kind === "same-code-shadow"
          || required?.disposition?.kind === "not-independently-discriminated";
        if (!independentlyOwned) fail("CENSUS_DELEGATED_OUTCOME_COVER", `${owner.id}->${requiredId}`);
      }
    }
    const ownershipCounts = {
      rejectPreservingOwnership: manifest.entries.filter((entry) => entry.ownershipRecord?.kind === "reject-preserving-ownership").length,
      mixedOwnership: manifest.entries.filter((entry) => entry.ownershipRecord?.kind === "mixed-ownership").length,
    };
    for (const [name, current] of Object.entries(ownershipCounts)) {
      const floor = manifest.floors?.ownershipCounts?.[name];
      if (!Number.isSafeInteger(floor) || floor < 0 || current < floor) {
        fail("CENSUS_OWNERSHIP_COUNT_REGRESSION", `${name}: current=${current} floor=${floor}`);
      }
      if (current > floor && !manifest.floors?.ownershipGrowthReasons?.[name]) {
        fail("CENSUS_OWNERSHIP_COUNT_GROWTH", `${name}: current=${current} floor=${floor}`);
      }
    }
  }
  if (requireBaseline) {
    const sinkProjection = graph.entries.filter((entry) => entry.kind === "rejection-site"
      && (entry.spelling === "fail" || entry.spelling === "verdict:RED"));
    const independent = manifest.baseline?.independentProjection;
    if (!projection || JSON.stringify(independent) !== JSON.stringify(projection)) fail("CENSUS_INDEPENDENT_PROJECTION", "regex projection changed or was not supplied");
    if (!counterexamples || JSON.stringify(manifest.baseline?.counterexampleUniverse) !== JSON.stringify(counterexamples)) {
      fail("CENSUS_COUNTEREXAMPLE_UNIVERSE", "named case or positive-corpus set changed or was not supplied");
    }
    if (JSON.stringify(manifest.baseline?.sharedContextPredicates) !== JSON.stringify(graph.sharedContextPredicates)) {
      fail("CENSUS_SHARED_CONTEXT_PROOF", "shared-context predicate proof changed");
    }
    if (JSON.stringify(manifest.baseline?.sameCodeShadows) !== JSON.stringify(graph.sameCodeShadows)) {
      fail("CENSUS_SAME_CODE_SHADOW_PROOF", "same-code shadow proof changed");
    }
    if (JSON.stringify(manifest.baseline?.downstreamDomainShadows) !== JSON.stringify(graph.downstreamDomainShadows)) {
      fail("CENSUS_DOWNSTREAM_DOMAIN_PROOF", "downstream-domain shadow proof changed");
    }
    if (JSON.stringify(manifest.baseline?.successPathCalls) !== JSON.stringify(graph.successPathCalls)) {
      fail("CENSUS_SUCCESS_PATH_PROOF", "success-path call proof changed");
    }
    if (JSON.stringify(manifest.baseline?.delegatedOutcomeCalls) !== JSON.stringify(graph.delegatedOutcomeCalls)) {
      fail("CENSUS_DELEGATED_OUTCOME_PROOF", "delegated-outcome call proof changed");
    }
    const analyzerCounts = {
      fail: sinkProjection.filter((entry) => entry.spelling === "fail").length,
      "verdict:RED": graph.entries.filter((entry) => entry.kind === "rejection-site" && entry.spelling === "verdict:RED").length,
    };
    if (JSON.stringify(analyzerCounts) !== JSON.stringify(independent.counts)
      || manifest.baseline?.currentSinkProjection !== independent.sites.length) {
      fail("CENSUS_BASELINE_RECONCILIATION", `analyzer=${JSON.stringify(analyzerCounts)} independent=${JSON.stringify(independent.counts)}`);
    }
  }
  return true;
}
