# Local open PDK clones (not committed)

Preferred on-disk location when C: is full:

- `E:\actoviq-pdks\` (slim / simulation-oriented fetch)

| Adapter | Official source | Slim notes |
|---|---|---|
| `ihp-sg13g2` | https://github.com/IHP-GmbH/IHP-Open-PDK | Sparse `libs.tech` (includes ngspice) |
| `sky130` | https://github.com/google/skywater-pdk | Only `libraries/sky130_fd_pr/latest` |
| `gf180mcu` | https://github.com/google/gf180mcu-pdk | Only primitive `fd_pr` submodule |

Full recursive clones (all stdcells + GDS) need tens of GB and often fail when
`C:` / app `userData` is nearly full.

**PDK install root** is a per-user desktop setting (`pdkInstallRoot` in
`~/.actoviq/actoviq-circuit-agent-desktop.json`). Leave it blank to use
`userData/pdks`. Set it in **Settings → IC tools and PDKs** (Browse / App default).

Retry script: `_retry-clone-all.ps1` (writes under `E:\actoviq-pdks`).
