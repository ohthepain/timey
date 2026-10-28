# Local issue helper dependency

`timey-local-issues-1.0.0.tgz` packages the existing issue skill and its standalone
helpers, assets and licenses. The files are unchanged from the installed bundle.
`local-issues-content-sha256.json` records each archived file's SHA-256;
`package.json` inside the archive records provenance and the original human-input
version manifest. The YAML and upstream MIT licenses are included.

The private `@timey/local-issues` development dependency is installed from this
archive by the frozen pnpm lockfile. `.agents/skills/issues` points to that
installed package with a relative link, so fresh clones and exported verification
snapshots resolve the same helpers without a personal checkout or network fetch
for the skill. The existing protocol and bundle-integrity checks remain active.

When deliberately updating the bundle, preserve its original bytes and version
manifest, include its assets and licenses, refresh the content hashes and lockfile,
and run verification from a clean dependency installation. Do not replace the
bundle with a stub or bypass its integrity check to repair a failed test.
