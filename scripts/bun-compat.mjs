// Bundle-only shim: dsh-llm reads its package version through an opaque
// createRequire(import.meta.url). Bun cannot relocate that dynamic path.
// Embed the exact installed version; do not change native Session/codec logic.
export function embedDshVersion(source, version) {
  const expression = 'createRequire(import.meta.url)("../package.json")';
  if (source.split(expression).length !== 2 || !/^\d+\.\d+\.\d+[\w.+-]*$/.test(version)) throw new Error('DSH Bun 版本嵌入规则与依赖源码不匹配，请检查依赖升级');
  return source.replace(expression, JSON.stringify({ version }));
}
