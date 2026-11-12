import { readFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import ts from 'typescript';
import { z } from 'zod';

const LinkSchema = z
  .object({
    requirementId: z.string().regex(/^(?:FR-[A-Z]+|NFR)-\d+$/),
    testFile: z.string().min(1),
    testTitle: z.string().min(1),
    coverageNote: z.string().min(10),
  })
  .strict();
export type TestLink = z.infer<typeof LinkSchema>;
export async function loadTestLinks(root: string, requirements: readonly string[], manifestPath: string): Promise<TestLink[]> {
  let text: string;
  try {
    text = await readFile(manifestPath, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
  // Only an absent optional manifest is ignored. A missing referenced test,
  // invalid JSON, invalid title or unknown requirement remains a hard failure.
  return validateTestLinks(root, requirements, JSON.parse(text));
}
/** This validates navigable source links, never claims the linked tests passed
 * or that a narrow test proves the entire requirement. */
export async function validateTestLinks(root: string, requirements: readonly string[], raw: unknown): Promise<TestLink[]> {
  const links = z.array(LinkSchema).parse(raw),
    allowed = new Set(requirements),
    titles = new Map<string, Set<string>>();
  for (const link of links) {
    if (!allowed.has(link.requirementId)) throw Error('Traceability link references an out-of-scope requirement');
    const path = resolve(root, link.testFile),
      inside = relative(root, path);
    if (isAbsolute(link.testFile) || inside.startsWith('..') || isAbsolute(inside) || !/[.](?:test|spec)[.]tsx?$/.test(path))
      throw Error('Traceability link must name a repository test file');
    let found = titles.get(path);
    if (!found) {
      found = new Set<string>();
      const source = ts.createSourceFile(path, await readFile(path, 'utf8'), ts.ScriptTarget.Latest, true);
      const base = (node: ts.Expression): string | undefined =>
        ts.isIdentifier(node)
          ? node.text
          : ts.isPropertyAccessExpression(node)
            ? base(node.expression)
            : ts.isCallExpression(node)
              ? base(node.expression)
              : undefined;
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ['it', 'test', 'describe'].includes(base(node.expression) ?? '')) {
          const title = node.arguments[0];
          if (title && (ts.isStringLiteral(title) || ts.isNoSubstitutionTemplateLiteral(title))) found?.add(title.text);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      titles.set(path, found);
    }
    if (!found.has(link.testTitle)) throw Error(`Traceability title does not identify an actual test declaration: ${link.testFile}`);
  }
  return links;
}
