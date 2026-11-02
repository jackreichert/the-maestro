/**
 * Per-file quality metrics for the ratchet: line count, longest function, max cyclomatic
 * complexity and the number of functions over either limit. Parsing uses the TypeScript 5
 * compiler API (the `typescript-api` alias) because the repo's own `typescript` is the native
 * 7.x build, which has no stable in-process parser.
 */
import ts from 'typescript-api';

export const LIMITS = { fileLines: 500, functionLines: 60, complexity: 15 } as const;

export interface FileMetrics {
  lines: number;
  longestFunction: number;
  maxComplexity: number;
  overThreshold: number;
}

interface FnStat { length: number; complexity: number }

const BRANCH_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

/** Whether a node opens its own function scope, with its own complexity count. */
function isFunctionLike(node: ts.Node): boolean {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)
    || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node);
}

/** Whether a node adds one decision path. */
function addsBranch(node: ts.Node): boolean {
  if (ts.isBinaryExpression(node)) return BRANCH_OPERATORS.has(node.operatorToken.kind);
  if (ts.isCaseClause(node)) return true;
  return ts.isIfStatement(node) || ts.isConditionalExpression(node) || ts.isCatchClause(node)
    || ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)
    || ts.isWhileStatement(node) || ts.isDoStatement(node);
}

function complexityOf(fn: ts.Node): number {
  let count = 1;
  const visit = (node: ts.Node): void => {
    if (addsBranch(node)) count += 1;
    ts.forEachChild(node, (child) => { if (!isFunctionLike(child)) visit(child); });
  };
  ts.forEachChild(fn, (child) => { if (!isFunctionLike(child)) visit(child); });
  return count;
}

function collectFunctions(sf: ts.SourceFile): FnStat[] {
  const stats: FnStat[] = [];
  const visit = (node: ts.Node): void => {
    if (isFunctionLike(node) && (node as ts.FunctionLikeDeclaration).body) {
      const start = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
      const end = sf.getLineAndCharacterOfPosition(node.getEnd()).line;
      stats.push({ length: end - start + 1, complexity: complexityOf(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return stats;
}

/** Measure one TypeScript source text. */
export function measureSource(text: string, fileName = 'file.ts'): FileMetrics {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const fns = collectFunctions(sf);
  const lines = text.length === 0 ? 0 : text.replace(/\n$/, '').split('\n').length;
  return {
    lines,
    longestFunction: Math.max(0, ...fns.map((f) => f.length)),
    maxComplexity: Math.max(0, ...fns.map((f) => f.complexity)),
    overThreshold: fns.filter((f) => f.length > LIMITS.functionLines || f.complexity > LIMITS.complexity).length,
  };
}

/** Whether metrics meet every limit outright (what a new file must do). */
export function meetsLimits(m: FileMetrics): boolean {
  return m.lines <= LIMITS.fileLines && m.longestFunction <= LIMITS.functionLines
    && m.maxComplexity <= LIMITS.complexity && m.overThreshold === 0;
}
