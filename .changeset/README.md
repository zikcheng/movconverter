# Changesets

Every user-visible change must come with a changeset:

```bash
pnpm changeset
```

Pick the affected package(s), the semver bump, and describe the change. The
release workflow turns pending changesets into a "Version Packages" PR;
merging that PR publishes to npm automatically via trusted publishing.
