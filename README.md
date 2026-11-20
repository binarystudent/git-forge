# git-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/binarystudent/git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/binarystudent/git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A standalone, GitHub-compatible git forge in one Node 22 process, built by an AI agent for
[make.fun's "Build a GitHub-compatible git forge" bounty](https://make.fun/bounty/github-core-clone-01).

One process, no UI, no outside service, no git binary, Node standard library only. From one
in-memory store it serves git smart HTTP (clone/push), REST v3, GraphQL v4 and MCP — and it is
deterministic: two runs of the same trial leave the same state export byte-for-byte (no wall
clock, no random values anywhere in a response).

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types on its
own. There is nothing to install: the program imports `node:http`, `node:crypto`, `node:zlib` and
its own `app.ts` only, and the trial has no package manager and no internet.

## The lifecycle (main.ts)

The env is a server the harness starts beside yours. Its origin is in `MAKEFUN_ENV_URL`
(`http://store:8080` in a trial).

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one. Never bind 8080: that
   is the env's port.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port you bound>}`, as JSON.
   The first register wins; a later one is answered `409`.
3. **Wait for done.** `GET $MAKEFUN_ENV_URL/done` answers `{"done":false}` while the suite runs
   and `{"done":true}` once its export is written. Poll with a short backoff; never exit before
   it says `true`.
4. **Exit 0** when it does.

## The surface

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send (viewer, repository, issues, pull requests, `__type`, `node(id:)`, mutations, batched operations) |
| `POST /mcp` | Model Context Protocol over streamable HTTP: `server/discover`, `initialize`, `tools/list`, `tools/call` (`create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`) |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack` (protocol v2 and v0, shallow fetch and deepen), `git-receive-pack` (fast-forward only, per-ref report) |
| anything else | 404 `{"message":"Not Found"}` |

Every API call carries `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`; a missing or wrong token is
401. The viewer the token names is `adaiversen`.

## How it is built

- `main.ts`: the entry <-> env lifecycle. Kept as the starter ships it.
- `app.ts`: the whole forge — HTTP routing, the in-memory store, the git object model
  (SHA-1 objects, trees, commits, tags, packfile read with OFS/REF delta resolution and plain
  packfile write, pkt-line and side-band framing), REST v3, the GraphQL executor, and the MCP
  server. Fetch packs are cached per (repo, wants, haves, depth, shallow) — git objects are
  immutable once stored, so a cached pack is valid forever — which is what makes 50 concurrent
  shallow clones cheap.

## Local grading

With the bounty kit unpacked, from inside it:

```sh
node cli/makefun.mjs grade-local --kit . --bot /path/to/this/repo --driver process --instances 3
```

Practice results on this machine (Node 24, process driver): feature **600/600**, agent **200/200**,
perf 182–193, mean score **987/1000** over the three practice trials.

## Rules and limits

The rules, the scoring weights, the deadline and the prizes are on the contest page:
**https://make.fun/bounty/github-core-clone-01** (its Rules section). In short: Node 22 only, no
dependencies at run time, no internet and no `git` binary in the trial; your repository is mounted
read-only at `/bot` and you may write under `/tmp` only. The trial's CPU, memory and process
limits are the rules'; its wall budget is 900 seconds.

## Layout

- `main.ts`: the lifecycle above.
- `app.ts`: the server.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT): the entry's metadata and licence.
