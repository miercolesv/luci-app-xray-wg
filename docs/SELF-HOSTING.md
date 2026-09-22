# Running your own server

You do not need a commercial provider. The server side is two daemons on any
VPS: WireGuard, and xray-core presenting a VMess frontend in front of it.

```
router (this package)                      your VPS
  wg0  ->  127.0.0.1:61554/udp
             xray dokodemo-door
                 |  VMess/TCP, HTTP-disguised
                 +-------------------------->  :80  xray VMess inbound
                                                      |  freedom outbound
                                                      +--> 127.0.0.1:51820/udp
                                                             WireGuard
```

The client tells xray the final destination, so the server needs no routing
rules of its own: a plain `freedom` outbound delivers each packet to the
WireGuard port the client asked for.

## 1. WireGuard on the server

```sh
umask 077
wg genkey | tee server.key | wg pubkey > server.pub
wg genkey | tee client.key | wg pubkey > client.pub
```

`/etc/wireguard/wg0.conf`:

```ini
[Interface]
Address    = 10.8.0.1/24
ListenPort = 51820
PrivateKey = <server.key>

[Peer]
PublicKey  = <client.pub>
AllowedIPs = 10.8.0.2/32
```

```sh
wg-quick up wg0
sysctl -w net.ipv4.ip_forward=1
iptables -t nat -A POSTROUTING -s 10.8.0.0/24 -o eth0 -j MASQUERADE
```

`ListenPort` is what you put in **Server port (WireGuard)** in the UI. It does
not have to be reachable from the internet — only from the VPS itself, since
traffic arrives through xray. Firewalling it off from the outside is a good
idea: it removes the only UDP signature on the box.

## 2. xray on the server

Pick an id and keep it secret — it is the only thing authenticating clients:

```sh
xray uuid
```

`/usr/local/etc/xray/config.json`:

```json
{
  "log": { "loglevel": "warning" },
  "inbounds": [{
    "port": 80,
    "protocol": "vmess",
    "settings": { "clients": [ { "id": "PASTE-YOUR-UUID", "alterId": 0 } ] },
    "streamSettings": {
      "network": "tcp",
      "tcpSettings": {
        "header": {
          "type": "http",
          "request": {
            "version": "1.1", "method": "GET", "path": ["/"],
            "headers": {
              "Host": ["www.example.com"],
              "User-Agent": ["Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/55.0.2883.75 Safari/537.36"],
              "Accept-Encoding": ["gzip, deflate"],
              "Connection": ["keep-alive"],
              "Pragma": "no-cache"
            }
          }
        }
      }
    }
  }],
  "outbounds": [{ "protocol": "freedom" }]
}
```

Port 80 is the point: the traffic has to look like the web. Set `Host` to
something plausible for your server's address; whatever you choose here must
match the **HTTP Host header** field in the UI.

Serve a real site on another port, or on the same one behind a reverse proxy,
if you want the address to survive someone actually visiting it.

## 3. The router

**VPN → Xray WireGuard → Settings**, profile **Self-hosted / manual**:

Nothing needs fetching: type the values straight in.

| Section | Field | Value |
|---|---|---|
| Server | Label | anything you like |
| Server | Server address | your VPS address |
| Server | WireGuard port | `51820` |
| Server | VMess frontend address | the same VPS address |
| Server | Frontend port | `80` |
| Server | VMess id | the uuid from step 2 |
| Server | Peer public key | contents of `server.pub` |
| Your WireGuard credentials | Private key | contents of `client.key` |
| Your WireGuard credentials | Assigned address | `10.8.0.2/24` |
| Your WireGuard credentials | DNS | `10.8.0.1`, or any resolver reachable inside the tunnel |
| Tunnel | HTTP Host header | the `Host` you chose in step 2 |
| Tunnel | Server list URL | leave empty |

Leave **Pick from the list** alone - it only exists to fill the Server fields
from a published list, and there is no list here.

The credentials can also be pasted in whole: **Paste WireGuard config** takes
a wg-quick file and fills in the private key, address and DNS for you.

Press **Save & Apply**, then **Connect** on the Status tab. An incomplete
config is still saveable; the service refuses to start and says which field is
missing.

## Does it work?

This arrangement was tested end to end before release — two network
namespaces, a real WireGuard server, a real xray on both sides, and the
client config produced by this package's own generator. The handshake
completes through the VMess transport and traffic flows. On the wire every
frame was TCP/80; no UDP appeared at all.

What that does not tell you: whether it survives a real network with a real
MTU path, a hostile middlebox, or sustained throughput. Start at MTU 1280 and
only raise it if you have a reason.

## Notes

- **The id is your only credential.** Anyone who has it can use your server.
- VMess is old and xray warns that it is deprecated in favour of VLESS. It is
  used here because it tunnels UDP over TCP with an HTTP disguise, which is
  the property this package needs. If you control both ends and do not need
  the disguise, plain WireGuard is faster and better.
- Obfuscation hides your VPN use from the local network and your ISP. It does
  not hide it from the sites you visit, which see your server's address.
