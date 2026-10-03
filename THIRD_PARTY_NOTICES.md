# Optional VPN component

This notice describes the optional VPN integration, not a complete inventory of all JavaScript and Python dependencies.

SEUdaily's own source is licensed under the MIT license in `LICENSE`. The separately executed **zju-connect** component has its own license: **GNU Affero General Public License, version 3 (AGPL-3.0)**. It is developed by the zju-connect project contributors; retain the copyright and dependency notices in its source tree.

- Project: https://github.com/Mythologyli/zju-connect
- Downloaded upstream release: `v1.3.1`, without modifications.
- Corresponding source commit: `5d7f5b11fcf231f72a0ec0d888bf0f2eadcce1da`.
- Source tree, dependency declarations and build instructions: https://github.com/Mythologyli/zju-connect/tree/5d7f5b11fcf231f72a0ec0d888bf0f2eadcce1da
- Source archive: https://github.com/Mythologyli/zju-connect/archive/5d7f5b11fcf231f72a0ec0d888bf0f2eadcce1da.tar.gz
- Full license text: [AGPL-3.0](src/seudaily/licenses/AGPL-3.0.txt).

SEUdaily downloads a platform-specific executable directly from the upstream release when VPN is first requested. Neither the repository nor the npm archive includes that executable. The download cache contains `LICENSE`, `SOURCE.txt`, and release provenance beside the executable. The upstream component is provided without warranty; the full license describes users' rights to copy, modify and redistribute it.

The application invokes the executable as an optional child process, supplies authentication through its command-line/stdin interface, and consumes its local HTTP proxy. It does not import, link or copy the component's implementation. These are the engineering boundaries supporting treatment as separate programs; on-demand downloading or separate processes alone do not establish a legal exemption. See [the integration assessment](docs/licensing-vpn.md).

When `SEUDAILY_VPN_BINARY` points to a user-provided executable, the pinned-release statements above describe our automatic downloader only. That executable's own version, license and corresponding source must be checked separately.
