/*
 * ESM resolve hook that lets a plugin written for DeepSeek Harness import
 * `@deepseek-ai/*` (or `@earendil-works/*`) packages from an installed DSH.
 *
 * The trick is to keep Node's own resolver: we only re-run `nextResolve` with a
 * synthetic parent inside the DSH install, so the whole node_modules algorithm
 * (exports maps, conditions, symlinks) still applies.
 */

let root = ''

export async function initialize(data) {
  root = data?.root ?? ''
}

export async function resolve(specifier, context, nextResolve) {
  const scoped = specifier.startsWith('@deepseek-ai/') || specifier.startsWith('@earendil-works/')
  if (!root || !scoped) return nextResolve(specifier, context)
  try {
    return await nextResolve(specifier, context)
  } catch (error) {
    try {
      const { pathToFileURL } = await import('node:url')
      const parentURL = pathToFileURL(`${root}/__qzcode_plugin_host__.js`).href
      return await nextResolve(specifier, { ...context, parentURL })
    } catch {
      throw error
    }
  }
}
