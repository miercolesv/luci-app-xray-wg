#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Shared helpers for luci-app-xray-wg. Sourced by the init script, the
# hotplug handler, the tunnel-up helper and the uci-defaults script.

XWG_CONF_DIR="/var/etc/xray-wg"
XWG_XRAY_CONF="$XWG_CONF_DIR/xray.json"
XWG_STATE_DIR="/var/run/xray-wg"
XWG_PINNED_FILE="$XWG_STATE_DIR/pinned_route"
XWG_GEN_FILE="$XWG_STATE_DIR/generation"
XWG_GENCONFIG="/usr/libexec/xray-wg/genconfig"
XWG_XRAY_BIN="/usr/bin/xray"

xwg_log() {
	local level="$1"; shift
	logger -t xray-wg -p "daemon.$level" -- "$*"
}

xwg_get() {
	uci -q get "xray_wg.$1.$2"
}

xwg_enabled() {
	[ "$(xwg_get settings enabled)" = "1" ]
}

# --- Start generation -------------------------------------------------------
#
# Each start_service stamps a new generation token. The detached tunnel-up
# helper carries the token it was launched with and re-checks it before every
# side effect, so a restart silently invalidates any waiter still counting
# down from the previous start instead of letting it ifup into a service that
# has since been stopped or reconfigured. Nothing is held, so nothing leaks if
# a waiter is killed.

xwg_new_generation() {
	local token
	token="$(date +%s).$$"
	mkdir -p "$XWG_STATE_DIR"
	echo "$token" > "$XWG_GEN_FILE"
	echo "$token"
}

xwg_clear_generation() {
	rm -f "$XWG_GEN_FILE"
}

# xwg_generation_is <token> - false once a newer start has superseded us.
xwg_generation_is() {
	[ -n "$1" ] || return 1
	[ "$1" = "$(cat "$XWG_GEN_FILE" 2>/dev/null)" ]
}

# --- UDP socket inspection (no netstat/ss dependency) -----------------------

# xwg_udp_port_busy <port> - true if anything holds that UDP port locally.
xwg_udp_port_busy() {
	local hex
	hex=$(printf '%04X' "$1" 2>/dev/null) || return 1
	awk -v want=":$hex" '
		FNR > 1 {
			split($2, a, ":")
			if (":" a[2] == want) { found = 1; exit }
		}
		END { exit !found }
	' /proc/net/udp /proc/net/udp6 2>/dev/null
}

# xwg_wait_udp_port <port> <timeout_seconds> [generation_token]
# Aborts early if a newer start has superseded the given generation.
xwg_wait_udp_port() {
	local port="$1" left="${2:-15}" token="$3"
	while [ "$left" -gt 0 ]; do
		xwg_udp_port_busy "$port" && return 0
		[ -n "$token" ] && ! xwg_generation_is "$token" && return 2
		left=$((left - 1))
		sleep 1
	done
	return 1
}

# --- Upstream interface resolution ------------------------------------------
#
# Everything is resolved from the *logical* netifd interface rather than from
# `ip route show default`, because once the tunnel is up the default route is
# the tunnel and reading it back would pin the VMess frontend into the very
# tunnel the pin exists to keep it out of.

xwg_iface_device() {
	ubus call "network.interface.$1" status 2>/dev/null |
		jsonfilter -e '@.l3_device' 2>/dev/null
}

# Empty when the interface has no IPv4 default route, or when its next hop is
# 0.0.0.0 - netifd reports that for a directly-attached or point-to-point
# link, and `ip route ... via 0.0.0.0` is not a usable route.
xwg_iface_gateway() {
	ubus call "network.interface.$1" status 2>/dev/null |
		jsonfilter -e '@.route[@.target="0.0.0.0"].nexthop' 2>/dev/null |
		grep -E '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' |
		grep -v -m1 '^0\.0\.0\.0$'
}

# xwg_detect_upstream <iface_to_exclude> - first up interface that owns an
# IPv4 default route. Used at install time and as a runtime fallback.
xwg_detect_upstream() {
	local exclude="$1" name
	for name in $(ubus call network.interface dump 2>/dev/null |
			jsonfilter -e '@.interface[*].interface' 2>/dev/null); do
		case "$name" in
			loopback|lo) continue ;;
		esac
		[ "$name" = "$exclude" ] && continue
		[ -n "$(xwg_iface_gateway "$name")" ] || continue
		echo "$name"
		return 0
	done
	return 1
}

# xwg_upstream_iface - configured value, or auto-detected, never the tunnel.
xwg_upstream_iface() {
	local want wg
	want=$(xwg_get settings upstream_iface)
	wg=$(xwg_get wg iface)
	if [ -n "$want" ] && [ "$want" != "$wg" ]; then
		echo "$want"
		return 0
	fi
	xwg_detect_upstream "$wg"
}

# --- Host route pinning ------------------------------------------------------
#
# xray's own connection to the VMess frontend must not enter the tunnel it is
# building. A /32 via the real uplink keeps it outside. Re-applied on uplink
# changes because the reference topology's uplink is a WiFi client link.

xwg_pin_route() {
	local dest="$1" up gw dev
	[ -n "$dest" ] || return 1

	up=$(xwg_upstream_iface)
	[ -n "$up" ] || { xwg_log err "no upstream interface found; cannot pin route to $dest"; return 1; }

	dev=$(xwg_iface_device "$up")
	[ -n "$dev" ] || { xwg_log err "upstream '$up' has no L3 device; cannot pin route to $dest"; return 1; }

	gw=$(xwg_iface_gateway "$up")

	if [ -n "$gw" ]; then
		ip route replace "$dest/32" via "$gw" dev "$dev" 2>/dev/null
	else
		# Point-to-point uplink (PPP and friends) has no next hop.
		ip route replace "$dest/32" dev "$dev" 2>/dev/null
	fi || {
		xwg_log err "failed to pin $dest/32 via ${gw:-direct} dev $dev"
		return 1
	}

	mkdir -p "$XWG_STATE_DIR"
	echo "$dest" > "$XWG_PINNED_FILE"
	xwg_log info "pinned $dest/32 via ${gw:-$dev} (upstream $up)"
	return 0
}

xwg_unpin_route() {
	local dest
	[ -f "$XWG_PINNED_FILE" ] || return 0
	dest=$(cat "$XWG_PINNED_FILE" 2>/dev/null)
	[ -n "$dest" ] && ip route del "$dest/32" 2>/dev/null
	rm -f "$XWG_PINNED_FILE"
	return 0
}

xwg_is_pinned() {
	[ -f "$XWG_PINNED_FILE" ]
}

# --- netifd WireGuard interface ----------------------------------------------
#
# The interface is generated from xray_wg so the user never edits
# /etc/config/network by hand.

xwg_sync_network() {
	local iface pk addr dns mtu keepalive peer_pk port peer

	iface=$(xwg_get wg iface)
	pk=$(xwg_get wg private_key)
	addr=$(xwg_get wg address)
	dns=$(xwg_get wg dns)
	mtu=$(xwg_get wg mtu)
	keepalive=$(xwg_get wg persistent_keepalive)
	peer_pk=$(xwg_get server public_key)
	port=$(xwg_get settings local_port)

	uci -q set "network.$iface=interface"
	uci -q set "network.$iface.proto=wireguard"
	uci -q set "network.$iface.private_key=$pk"
	uci -q delete "network.$iface.addresses"
	uci -q add_list "network.$iface.addresses=$addr"
	uci -q set "network.$iface.mtu=$mtu"
	# Brought up explicitly by this package, in order, after xray is listening.
	uci -q set "network.$iface.auto=0"
	uci -q delete "network.$iface.dns"
	[ -n "$dns" ] && uci -q add_list "network.$iface.dns=$dns"

	# Replace all peers rather than merging, so a server change cannot leave a
	# stale peer behind.
	while uci -q delete "network.@wireguard_$iface[0]"; do :; done

	peer=$(uci -q add network "wireguard_$iface") || return 1
	uci -q set "network.$peer.public_key=$peer_pk"
	uci -q set "network.$peer.endpoint_host=127.0.0.1"
	uci -q set "network.$peer.endpoint_port=$port"
	# Two halves rather than 0.0.0.0/0, the way wg-quick does it, and for the
	# same reason: netifd turns each allowed_ips entry into a route, and a
	# 0.0.0.0/0 route replaces the uplink's own default at equal metric. netifd
	# does not notice, so when the tunnel goes down it withdraws its default
	# and never reinstates the uplink's - leaving the router with no default
	# route at all. 0.0.0.0/1 and 128.0.0.0/1 cover the same space, still beat
	# any default on prefix length, and never collide with it.
	uci -q add_list "network.$peer.allowed_ips=0.0.0.0/1"
	uci -q add_list "network.$peer.allowed_ips=128.0.0.0/1"
	uci -q set "network.$peer.route_allowed_ips=1"
	uci -q set "network.$peer.persistent_keepalive=$keepalive"

	uci -q commit network
}

# --- Firewall ----------------------------------------------------------------

_xwg_fw_zone_of_network() {
	local i=0 name nets net
	while name=$(uci -q get "firewall.@zone[$i].name"); do
		nets=$(uci -q get "firewall.@zone[$i].network")
		for net in $nets; do
			[ "$net" = "$1" ] && { echo "$name"; return 0; }
		done
		i=$((i + 1))
	done
	return 1
}

# Mirror every forwarding that currently targets the upstream zone onto the
# tunnel zone, so the same LAN/AP networks keep working without assuming that
# the source zone is called 'lan' or the destination zone 'wan'.
xwg_firewall_apply() {
	local wgif upif zone upzone srcs src sec i dest reloaded=0

	[ "$(xwg_get firewall manage)" = "1" ] || return 0

	wgif=$(xwg_get wg iface)
	zone=$(xwg_get firewall zone_name)
	upif=$(xwg_upstream_iface)

	uci -q set "firewall.xray_wg=zone"
	uci -q set "firewall.xray_wg.name=$zone"
	uci -q set "firewall.xray_wg.input=REJECT"
	uci -q set "firewall.xray_wg.output=ACCEPT"
	uci -q set "firewall.xray_wg.forward=REJECT"
	uci -q set "firewall.xray_wg.masq=1"
	uci -q set "firewall.xray_wg.mtu_fix=1"
	uci -q delete "firewall.xray_wg.network"
	uci -q add_list "firewall.xray_wg.network=$wgif"

	if [ -n "$upif" ]; then
		upzone=$(_xwg_fw_zone_of_network "$upif")
	fi

	if [ -n "$upzone" ]; then
		# Collect first, then write: appending named sections would otherwise
		# extend the list being iterated.
		i=0
		srcs=""
		while uci -q get "firewall.@forwarding[$i]" >/dev/null; do
			dest=$(uci -q get "firewall.@forwarding[$i].dest")
			src=$(uci -q get "firewall.@forwarding[$i].src")
			if [ "$dest" = "$upzone" ] && [ -n "$src" ] && [ "$src" != "$zone" ]; then
				srcs="$srcs $src"
			fi
			i=$((i + 1))
		done

		for src in $srcs; do
			# UCI section names accept [A-Za-z0-9_] only.
			case "$src" in
				*[!A-Za-z0-9_]*) xwg_log warn "skipping forwarding from zone '$src': name not usable as a UCI section"; continue ;;
			esac
			sec="xray_wg_fwd_$src"
			uci -q set "firewall.$sec=forwarding"
			uci -q set "firewall.$sec.src=$src"
			uci -q set "firewall.$sec.dest=$zone"
		done
	else
		xwg_log warn "could not resolve the firewall zone owning upstream '${upif:-unknown}'; add forwarding to zone '$zone' manually"
	fi

	uci -q commit firewall
	/etc/init.d/firewall reload >/dev/null 2>&1 && reloaded=1
	[ "$reloaded" = "1" ] || xwg_log warn "firewall reload failed"
	return 0
}

# True when the loopback UDP port is held by the xray this service manages.
#
# procd does not retire a running instance until start_service returns, so on a
# second start our own xray is still holding the port. Treating that as a
# conflict is worse than useless: start_service fails, procd is handed no
# instance at all, and it then kills the xray that was working - taking the
# tunnel with it. Matching on our own config path is exact, because it is the
# only xray this package ever launches.
xwg_port_held_by_us() {
	local pid cmd

	for pid in $(ls /proc 2>/dev/null); do
		case "$pid" in
			''|*[!0-9]*) continue ;;
		esac
		cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null) || continue
		case "$cmd" in
			*"$XWG_XRAY_CONF"*) return 0 ;;
		esac
	done

	return 1
}

# --- netifd readiness ------------------------------------------------------

# netifd marks an interface "available" only once a handler for its proto has
# been registered, and it scans /lib/netifd/proto only at startup. A wireguard
# handler installed alongside this package is therefore invisible to the netifd
# that is already running: `ifup` returns success and silently does nothing, and
# the device never appears. Verified on OpenWrt 25.12: neither
# `/etc/init.d/network reload` nor `ubus call network reload` picks the handler
# up - only a full restart does.
xwg_iface_available() {
	ubus call "network.interface.$1" status 2>/dev/null |
		jsonfilter -e '@.available' 2>/dev/null | grep -qx true
}

xwg_wait_iface_available() {
	local iface="$1" tries="${2:-5}" i=0
	while [ "$i" -lt "$tries" ]; do
		xwg_iface_available "$iface" && return 0
		i=$((i + 1))
		sleep 1
	done
	return 1
}

# Usable means netifd has given the uplink an L3 device again - restarting the
# network tears it down, and a route pinned before it is back fails with
# "no L3 device", which is indistinguishable from a real misconfiguration.
xwg_wait_upstream() {
	local tries="${1:-45}" i=0 up
	while [ "$i" -lt "$tries" ]; do
		up=$(xwg_upstream_iface)
		if [ -n "$up" ] && [ -n "$(xwg_iface_device "$up")" ]; then
			return 0
		fi
		i=$((i + 1))
		sleep 1
	done
	return 1
}

# Present once the kernel device exists, which is the only honest proof that
# ifup did anything.
xwg_wait_device() {
	local iface="$1" tries="${2:-15}" i=0
	while [ "$i" -lt "$tries" ]; do
		[ -e "/sys/class/net/$iface" ] && return 0
		i=$((i + 1))
		sleep 1
	done
	return 1
}

# Up to 1.0.6 this package gave the tunnel a 0.0.0.0/0 route, which replaced
# the uplink's own default in the kernel at equal metric. netifd never noticed -
# it still reports the route as present - and it will not reinstate a route it
# does not believe is missing. A router upgraded from one of those versions is
# therefore left with no default route at all, and fixing the cause does not
# undo the damage. Repair the divergence by making netifd re-apply the uplink.
#
# Deliberately narrow: it acts only when netifd claims a gateway that the
# kernel does not have. A setup that legitimately has no default route (policy
# routing, for instance) claims none either, and is left alone.
xwg_repair_upstream_default() {
	local up claimed i=0

	ip -4 route show default 2>/dev/null | grep -q . && return 0

	up=$(xwg_upstream_iface)
	[ -n "$up" ] || return 1

	claimed=$(xwg_iface_gateway "$up")
	[ -n "$claimed" ] || return 1

	xwg_log warn "netifd claims a default route via $claimed that the kernel lacks; re-applying uplink '$up'"
	ifup "$up" 2>/dev/null

	while [ "$i" -lt 20 ]; do
		ip -4 route show default 2>/dev/null | grep -q . && {
			xwg_log info "default route via $claimed restored"
			return 0
		}
		i=$((i + 1))
		sleep 1
	done

	xwg_log err "uplink '$up' still has no default route after re-applying it"
	return 1
}

# --- Validation ---------------------------------------------------------------

# Writes human-readable reasons to stderr; returns non-zero if unusable.
xwg_validate() {
	local rc=0 mode port vport host frontend peer_pk priv addr mtu iface uuid wgport http_host

	mode=$(xwg_get settings mode)
	port=$(xwg_get settings local_port)
	vport=$(xwg_get server frontend_port)
	host=$(xwg_get server host)
	frontend=$(xwg_get server frontend)
	peer_pk=$(xwg_get server public_key)
	priv=$(xwg_get wg private_key)
	addr=$(xwg_get wg address)
	mtu=$(xwg_get wg mtu)
	iface=$(xwg_get wg iface)

	_fail() { echo "xray-wg: $1" >&2; xwg_log err "$1"; rc=1; }

	[ -x "$XWG_XRAY_BIN" ] || _fail "xray not found at $XWG_XRAY_BIN (install xray-core)"

	case "$mode" in
		tcp) ;;
		quic) _fail "mode 'quic' is not implemented yet; only 'tcp' is supported" ;;
		*) _fail "invalid mode '$mode' (expected 'tcp')" ;;
	esac

	case "$port" in
		''|*[!0-9]*) _fail "settings.local_port must be numeric" ;;
		*) [ "$port" -ge 1 ] && [ "$port" -le 65535 ] || _fail "settings.local_port out of range" ;;
	esac

	case "$vport" in
		''|*[!0-9]*) _fail "server.frontend_port must be numeric" ;;
		*) [ "$vport" -ge 1 ] && [ "$vport" -le 65535 ] || _fail "server.frontend_port out of range" ;;
	esac

	# genconfig requires it, so catch it here rather than letting config
	# generation fail with a less obvious message.
	http_host=$(xwg_get settings http_host)
	[ -n "$http_host" ] || _fail "settings.http_host is empty (the Host header the frontend expects)"

	[ -n "$iface" ] || _fail "wireguard.iface is empty"
	[ -n "$host" ] || _fail "server.host is empty"
	[ -n "$frontend" ] || _fail "server.frontend (VMess frontend address) is empty"
	uuid=$(xwg_get server uuid); wgport=$(xwg_get server wg_port)
	[ -n "$uuid" ] || [ -f /etc/xray-wg/servers.json ] || _fail "server.uuid is empty and no server list has been fetched"
	[ -n "$wgport" ] || [ -f /etc/xray-wg/servers.json ] || _fail "server.wg_port is empty and no server list has been fetched"
	[ -n "$peer_pk" ] || _fail "server.public_key is empty (the server's WireGuard public key)"
	[ -n "$priv" ] || _fail "wireguard.private_key is empty"
	[ -n "$addr" ] || _fail "wireguard.address is empty"

	case "$mtu" in
		''|*[!0-9]*) _fail "wireguard.mtu must be numeric" ;;
	esac

	[ -n "$(xwg_upstream_iface)" ] || _fail "no upstream interface with a default route; set settings.upstream_iface"

	return $rc
}
