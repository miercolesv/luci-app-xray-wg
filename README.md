# luci-app-xray-wg

Carries WireGuard inside an xray VMess transport, so the local network and
the ISP see ordinary HTTP traffic instead of a WireGuard handshake. Driven
entirely from LuCI.

Works with a server you run yourself — see **[docs/SELF-HOSTING.md](docs/SELF-HOSTING.md)** —
or with any provider that publishes a compatible server list.

## What it does

```
[LAN clients] -> xwg0 (WireGuard) -> 127.0.0.1:61554/udp
                                       |
                             xray dokodemo-door inbound
                                       |
                             VMess/TCP outbound (HTTP-disguised)
                                       |
                     [frontend]:80  ->  [WireGuard server]:<port>
```

WireGuard's peer endpoint is loopback. The real server address lives in
xray's inbound settings, so WireGuard never learns it and never puts a
recognisable handshake on the wire.

Nothing about any particular provider is compiled in. The VMess id and the
server's WireGuard port are either typed in or read from a fetched server
list; an unresolvable value is a hard error rather than a silent failure.

## Everything is configured from LuCI

Under **VPN → Xray WireGuard**:

- **Status** — xray listener, host-route pin, tunnel state, last-handshake
  age, an on-demand exit-address check, and Connect / Disconnect / Reconnect.
  Anything that would stop the service starting is listed with a link to the
  field that fixes it.
- **Settings** — profile picker, server fields, WireGuard credentials with a
  paste-a-wg-quick-config box, and the advanced fields (local port, MTU, HTTP
  Host header, uplink interface, firewall zone).

### The routing loop

Once the tunnel carries `0.0.0.0/0`, xray's own connection to the frontend
would be routed into the tunnel it is building. The service installs a `/32`
host route to the frontend via the real uplink *before* bringing WireGuard
up, and re-installs it whenever the uplink changes — necessary when the
uplink is a WiFi client link that reassociates.

That hotplug handler fires for the tunnel interface too, so it exits early on
its own interface. Without that guard it would resolve the tunnel as the
uplink and pin the frontend into the tunnel, killing the connection at the
moment it succeeds.

Gateway and device are always re-resolved from the *logical* netifd interface
via ubus, never from `ip route show default`, which stops being meaningful
once the tunnel holds the default route. The uplink is auto-detected at
install time; nothing assumes it is called `wan`.

A restart while a previous start is still waiting for xray's socket is
handled with a generation token rather than a lock: each start stamps a new
token and any waiter carrying an older one exits quietly. A killed waiter
leaves no state behind.

## Install

Download the `.apk` from [Releases](../../releases) and upload it under
**System → Software** in LuCI. The post-install script enables the service,
detects your uplink and reloads rpcd, so the browser is all you need after
that.

There is also a signed apk repository, if you would rather get upgrades
through `apk update`. The package is `noarch`, so one repository serves every
router:

```sh
wget -O /etc/apk/keys/xray-wg-repo.pub.pem \
  https://miercolesv.github.io/luci-app-xray-wg/xray-wg-repo.pub.pem

echo "https://miercolesv.github.io/luci-app-xray-wg/packages.adb" \
  >> /etc/apk/repositories.d/customfeeds.list

apk update && apk add luci-app-xray-wg
```

A signature proves a package came from this project's key, not that it is
safe.

## Configuration

`/etc/config/xray_wg`, mode `0600` because it holds your WireGuard private
key. You should not need to open it.

Required before the service will start; the Status page names whichever are
missing:

| Option | Where it comes from |
|---|---|
| `server.host`, `server.wg_port` | your server, or a fetched list |
| `server.frontend`, `server.uuid`, `server.public_key` | same |
| `wireguard.private_key`, `wireguard.address` | your own keys |
| `wireguard.dns` | optional, but empty leaks DNS to the upstream resolver |

Paste a wg-quick config into the box on the Settings page and the last three
fill themselves in. Parsing happens in the browser.

MTU defaults to 1280. VMess framing inflates packets and 1420 fragments.

### From the shell, if you want it

```sh
/etc/init.d/xray-wg validate   # what the Status page lists as problems
/etc/init.d/xray-wg start
/etc/init.d/xray-wg status
logread -e xray-wg
```

## What it changes on the router

- Writes a `wireguard` interface (default `xwg0`) and its single peer into
  `/etc/config/network`, regenerated on every start. Peers are replaced
  wholesale so a server change cannot leave a stale one behind.
- Creates a masquerading firewall zone (default `xwgvpn`) holding that
  interface, and mirrors every existing forwarding that targets the uplink's
  zone onto it. That is why no zone name is hardcoded.
- Installs and removes one `/32` host route.

Known limitation: netifd requires the WireGuard private key in
`/etc/config/network`, which is not mode `0600`. That is inherent to every
OpenWrt WireGuard setup.

## Build

```sh
./scripts/feeds update -a && ./scripts/feeds install -a
cp -r luci-app-xray-wg package/
make defconfig
make package/luci-app-xray-wg/compile V=s
```

`LUCI_PKGARCH:=all` — one artifact serves every router. The only
architecture-specific component is `xray-core`, which the official feed
already builds for every target. OpenWrt 25.12 installs with `apk`, not
`opkg`.

On an **aarch64 build host** the published SDKs (x86_64 only) need
`qemu-user` + binfmt, and `xray-core`'s Go toolchain refuses to bootstrap:
install a native Go and set `CONFIG_GOLANG_EXTERNAL_BOOTSTRAP_ROOT="$(go env
GOROOT)"` with `CONFIG_GOLANG_BUILD_BOOTSTRAP` off. An x86_64 host needs none
of this.

CI builds on demand (**Actions → build → Run workflow**) and on any `v*` tag,
which also cuts a Release and republishes the signed repository. It fails the
build if the package is not `noarch`, if a declared dependency does not exist
in any feed, or if the JS minifier left stray files behind.

## What has been tested

- **The tunnel works.** Two network namespaces, a real WireGuard server, real
  xray on both sides, and the client config produced by this package's own
  generator: the handshake completes through the VMess transport and traffic
  flows. Every captured frame on the link was TCP/80; no UDP appeared.
- **The route pinning works against the real kernel.** With the tunnel
  holding `0.0.0.0/1` + `128.0.0.0/1`, traffic to the frontend still leaves
  via the real uplink, ordinary traffic is tunnelled, and removing the pin
  puts the frontend back inside the tunnel.
- Both ucode programs compile and run under the exact ucode revision
  ImmortalWrt 25.12.2 ships, not just a current build.
- The hotplug handler leaves the route alone for the tunnel interface, for an
  unrelated interface, and while the service is disabled; it re-pins after a
  simulated uplink reassociation.
- `xwg_sync_network`'s replacement produces correct netifd config and is
  idempotent across repeated runs.
- The rpcd backend was driven through its exec protocol end to end; `action`
  rejects anything outside its start/stop/restart whitelist.
- The wg-quick parser handles LF and CRLF input identically, before and after
  jsmin minification, and never mistakes a Peer `PublicKey` for a private key.

**Not tested: real router hardware.** Everything above ran on a Linux host.
No OpenWrt device has run this, and the tunnel has never crossed a real
network with a real MTU path.

## Risks

Obfuscation hides VPN use from the local network and the ISP. It does not
hide it from the sites you visit, which see your server's address unchanged.

VMess is deprecated upstream in favour of VLESS. It is used here because it
tunnels UDP over TCP with an HTTP disguise, which is the property this needs.
If you control both ends and do not need the disguise, plain WireGuard is
faster and better.

If you point this at a commercial provider, you are relying on parameters
that provider can change without notice, and doing something they are under
no obligation to support.

## Not implemented

- QUIC transport — the schema accepts `mode 'quic'`, validation rejects it
- Multi-hop
- Kill switch (blocking LAN egress while the tunnel is down)
- Translations (no `po/` yet; strings are wrapped in `_()`)
