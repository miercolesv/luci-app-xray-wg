# SPDX-License-Identifier: GPL-3.0-or-later
#
# Copyright (C) 2026 the luci-app-xray-wg contributors
#
# Carries WireGuard inside an xray VMess transport, driven from LuCI.

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-xray-wg
PKG_VERSION:=1.0.1
PKG_RELEASE:=1
PKG_LICENSE:=GPL-3.0-or-later
# luci.mk sets PKG_MAINTAINER to the LuCI community; it is not overridable
# here, so no maintainer line is set.

LUCI_TITLE:=LuCI support for WireGuard over an xray VMess transport
LUCI_DESCRIPTION:=Runs WireGuard inside a VMess/TCP transport provided by \
	xray-core, including the host-route pinning that keeps xray's own \
	uplink out of the tunnel it creates. Works with a self-hosted server \
	or any compatible provider.

# xray-core is the only architecture-specific component and the official feed
# already builds it for every target, so this package stays noarch.
LUCI_PKGARCH:=all

LUCI_DEPENDS:= \
	+luci-base \
	+xray-core \
	+wireguard-tools \
	+kmod-wireguard \
	+ucode \
	+ucode-mod-uci \
	+ucode-mod-fs \
	+jsonfilter \
	+curl \
	+ca-bundle

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
