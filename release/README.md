# PhotoFilter for DSH 0.2

Release candidate `0.4.0-rc.1`, tested against DSH `0.2.0-rc.2` only.
Requires macOS 14+, Node 24+, Swift 6 / Xcode command-line tools and Python 3.10+.
This is a photo-shortlisting assistant, not a validated replacement for your final selection.

## Install a candidate tarball

The npm-installed DSH CLI needs pnpm on PATH; the source installer supplies a pinned local copy. The DSH Desktop bundled command manages its own runtime.

Use an existing DSH Web/Desktop profile (`web` or `desktop`):

```sh
dsh plugin --profile web add /path/to/photo-filter-agent-dsh-photo-filter-v4-0.4.0-rc.1.tgz
```

For a new isolated Web profile, initialize it first:

```sh
dsh --profile photos --from-default-profile web --dump-config
dsh plugin --profile photos add /path/to/photo-filter-agent-dsh-photo-filter-v4-0.4.0-rc.1.tgz
```

A base-only profile has no preset registry. Use Web/Desktop for this release.
Install into the same `DSH_HOME` used by the running DSH application. Do not reuse old experiment homes.
The bundle contributes one PhotoFilter preset; it does not change the default preset or other chats.

Run the installed setup command (replace `web` with your profile):

```sh
"${DSH_HOME:-$HOME/.dsh}/profiles/web/node_modules/.bin/photofilter-setup" --install-deps --python python3.12
"${DSH_HOME:-$HOME/.dsh}/profiles/web/node_modules/.bin/photofilter-setup" --download-models
"${DSH_HOME:-$HOME/.dsh}/profiles/web/node_modules/.bin/photofilter-setup" --profile web --photos /path/to/photos --exports /path/to/export
```

Dependencies and model weights can require several GB and network access. They are installed only by these explicit commands, never by npm postinstall. The Swift binary is built locally for your Mac, outside the package directory. Cached third-party weights retain their upstream licenses; they are not included in the npm tarball.

Open a new DSH chat and select **PhotoFilter**. Ask it to scan and shortlist the authorized folder.
The default shortlist runs local inference. The conversational DSH model may still incur charges.
`stage2Vlm` and `stage3Vlm` are off. Configuring them on, or explicitly asking for `compare_within_groups`, can send derived JPEGs to your current model and incur additional calls. Model-assisted quality is not certified by the offline smoke tests.

Configure the `photofilter` plugin in DSH, or use the setup command to authorize directories (it backs up the profile patch and keeps unrelated rows). Running setup resets automatic visual review to off.
Exports require the existing two-step confirmation code; originals are copied, not moved. Session shortlists and tickets are intentionally in memory. After a restart, scan and rank again; old confirmation codes are invalid. Ranking caches and anonymous ID maps persist.

## Source build

```sh
npm ci
npm run typecheck
npm test
npm pack
```

The repository's `install.sh` is a different installation path: it installs the `photo-v4` / `photo-v4-headless` profiles from `profiles/` into a dedicated `DSH_HOME` (see the top-level README). This tarball is an alternative packaging for installing into an existing Web/Desktop profile.
Legacy `profiles/photo`, `profiles/photo-web` and `run.sh` are historical v3 configuration. Keep old experiment state intact.

## Publish

Confirm the package namespace and repository license before publication. Verify the actual tarball in a clean DSH home, then publish it with the `next` tag. Add `dsh-plugin` to the GitHub repository topics for discovery. DSH currently documents npm/GitHub/tarball installation, not a separate marketplace submission API.
