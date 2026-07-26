---
"@demake/web": patch
---

Fix the service worker pinning returning visitors to the build they first
loaded. Every asset is content-hashed and may be cached for ever, but
`index.html` is not — it is the file that names those hashed chunks, so serving
it from the cache made the app ask for the chunks it already had and a deploy
reached new visitors only. The symptom was a console added to the app not
appearing in the browser after the deploy that contained it. Navigations now go
to the network first and fall back to the cached shell, so offline still works,
and the cache name is bumped so a visitor carrying a stale shell is rescued.
