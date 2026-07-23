# Reserving the `demake` npm names

npm has no reservation mechanism — a name is only held once a package is
**published** under it (see [`docs/01-vision-and-goals.md`](../../docs/01-vision-and-goals.md)
§Naming). These are throwaway `0.0.1` placeholders whose only job is to secure
the names until the real release pipeline (doc 11) ships proper versions. They
are intentionally kept out of the pnpm workspace and build.

Two names to secure:

| Name            | Directory | Notes                                          |
| --------------- | --------- | ---------------------------------------------- |
| `demake`        | `demake/` | Unscoped. Publishable under any account.       |
| `@demake/core`  | `core/`   | Scoped — **requires the `demake` npm org**.    |

`@demake/cli-spec` is `private: true` and never published, so it needs nothing.

## Steps (run on your own machine, not in CI)

1. **Create the `demake` organization** so you own the scope. On npmjs.com:
   _Add Organization_ → name it `demake` → choose the **free / unlimited public
   packages** plan. This single step is what reserves the `@demake/*` scope.

2. **Log in:**

   ```sh
   npm login
   ```

3. **Publish both placeholders.** No `--provenance` — provenance only works from
   CI with OIDC trusted publishing, and these placeholders don't use it:

   ```sh
   cd tools/reserve-npm/demake && npm publish
   cd ../core                  && npm publish   # access:public is set in package.json
   ```

4. **Verify:**

   ```sh
   npm view demake version
   npm view @demake/core version
   ```

Done — the names are held. The real release (doc 11) will publish higher
versions with provenance from GitHub Actions; delete this folder once that
pipeline is live.
